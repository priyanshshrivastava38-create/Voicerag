// SYNTHETIC load test: many concurrent voice sessions over real WebSockets, real Postgres/pgvector
// retrieval and the real orchestration code, but MOCK speech/LLM/embedding providers with
// configurable simulated latencies. It measures orchestration overhead, concurrency behaviour,
// cancellation and slow-provider handling — NOT model latency. Uses the disposable test database.
//
//   npm run bench:load -- [--sessions 1,10,25,50] [--turns 5]
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.DATABASE_URL_TEST) throw new Error("DATABASE_URL_TEST required (the load test truncates it)");
Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL_TEST,
  VOICERAG_STORAGE_DIR: "./storage/test",
  STT_PROVIDER: "mock",
  LLM_PROVIDER: "mock",
  TTS_PROVIDER: "mock",
  EMBED_PROVIDER: "mock",
  RAG_MIN_VECTOR_SIM: "0.45",
  RAG_MIN_VECTOR_SIM_WITH_KEYWORD: "0.25",
  STT_PARTIAL_INTERVAL_MS: "0",
  VOICE_TURNS_PER_MINUTE: "100000",
  VOICE_MAX_SESSIONS_PER_USER: "1000",
});

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

// Simulated provider latencies (ms), chosen to resemble a fast hosted stack.
const SIM = { stt: 150, ttft: 300, token: 15, tts: 80 };

async function main() {
  const { default: WebSocket, WebSocketServer } = await import("ws");
  const { seeded } = await import("../tests/integration/helpers");
  const { issueSessionToken, SESSION_COOKIE } = await import("../src/lib/session");
  const { providers } = await import("../src/server/providers/registry");
  const { VoiceSession } = await import("../src/server/voice/session");
  const { encodeTextAsPcm } = await import("../src/server/providers/mock");
  const { decodeAudioFrame } = await import("../src/shared/protocol");
  const { summarize } = await import("../src/shared/stats");
  const { prisma } = await import("../src/lib/db");
  const { scopeFor } = await import("../src/server/access");

  const s = await seeded();
  const users = [s.alice, s.bob, s.admin];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((_q, r) => r.end());
  server.on("upgrade", async (req, socket, head) => {
    const { userFromToken, tokenFromCookieHeader } = await import("../src/lib/session");
    const user = await userFromToken(tokenFromCookieHeader(req.headers.cookie));
    if (!user) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => new VoiceSession(ws, user, providers(), { source: "synthetic-load" }).start());
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  for (const u of users) await scopeFor(u.id);

  const QUESTIONS = ["How many days of annual leave do I get each year?", "How many characters must passwords have?", "What is the per diem for international travel?", "What are the core working hours?", "Who won the football world cup?"];

  async function session(userId: string, turns: number, opts: { bargeInRate: number }) {
    const { token } = await issueSessionToken(userId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    ws.send(JSON.stringify({ t: "hello", config: { speak: true } }));
    const out: { firstAudioMs: number | null; outcome: string; bargeIn: boolean; staleFrames: number }[] = [];
    let handler: (d: Buffer, bin: boolean) => void = () => undefined;
    ws.on("message", (d, bin) => handler(d as Buffer, bin));
    for (let t = 0; t < turns; t++) {
      const q = QUESTIONS[(t + userId.length) % QUESTIONS.length];
      const bargeIn = Math.random() < opts.bargeInRate;
      const r = await new Promise<{ firstAudioMs: number | null; outcome: string; bargeIn: boolean; staleFrames: number }>((resolve) => {
        let endSent = 0;
        let firstAudio: number | null = null;
        let turnNum = -1;
        let cancelledTurn = -1;
        let afterCancel = false;
        let stale = 0;
        const timer = setTimeout(() => resolve({ firstAudioMs: null, outcome: "client_timeout", bargeIn, staleFrames: stale }), 30_000);
        handler = (d, bin) => {
          if (bin) {
            const f = decodeAudioFrame(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer)!;
            if (afterCancel && f.turnNum === cancelledTurn) stale++;
            if (f.turnNum === turnNum && firstAudio === null) {
              firstAudio = performance.now();
              if (bargeIn) {
                // User talks over the assistant: speech_start cancels the turn server-side.
                cancelledTurn = turnNum;
                ws.send(JSON.stringify({ t: "speech_start", uttId: `b${t}` }));
                ws.send(JSON.stringify({ t: "speech_abort", uttId: `b${t}` }));
              }
            }
            return;
          }
          const m = JSON.parse(String(d));
          if (m.t === "turn_start") turnNum = m.turnNum;
          if (m.t === "state" && m.state === "listening" && cancelledTurn >= 0) afterCancel = true;
          if (m.t === "turn_end") {
            clearTimeout(timer);
            // Allow in-flight frames to drain, then count any stale audio.
            setTimeout(() => resolve({ firstAudioMs: firstAudio ? Math.round(firstAudio - endSent) : null, outcome: m.outcome, bargeIn, staleFrames: stale }), bargeIn ? 150 : 0);
          }
        };
        const uttId = `u${t}`;
        ws.send(JSON.stringify({ t: "speech_start", uttId }));
        ws.send(Buffer.from(encodeTextAsPcm(q, 16000).buffer));
        ws.send(JSON.stringify({ t: "pause", uttId }));
        // Simulated VAD hangover: speculation runs during this window, as in the browser.
        setTimeout(() => {
          endSent = performance.now();
          ws.send(JSON.stringify({ t: "speech_end", uttId, speechMs: 1500, hangoverMs: 550 }));
        }, 550);
      });
      out.push(r);
    }
    ws.close();
    return out;
  }

  async function scenario(name: string, sessions: number, turns: number, env: Record<string, string>, bargeInRate = 0) {
    Object.assign(process.env, env);
    const t0 = performance.now();
    const res = (await Promise.all(Array.from({ length: sessions }, (_, i) => session(users[i % users.length].id, turns, { bargeInRate })))).flat();
    const wall = performance.now() - t0;
    const ok = res.filter((r) => r.outcome === "answered" || r.outcome === "abstained");
    const fa = summarize(ok.map((r) => r.firstAudioMs));
    return {
      name,
      sessions,
      turns: res.length,
      outcomes: res.reduce<Record<string, number>>((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {}),
      eosToFirstAudio: fa,
      cancelledWithStaleAudio: res.filter((r) => r.bargeIn && r.staleFrames > 0).length,
      throughputTurnsPerSec: +(res.length / (wall / 1000)).toFixed(1),
    };
  }

  const base = { MOCK_STT_MS: String(SIM.stt), MOCK_LLM_TTFT_MS: String(SIM.ttft), MOCK_LLM_TOKEN_MS: String(SIM.token), MOCK_TTS_MS: String(SIM.tts), MOCK_LLM_REPEAT: "1" };
  const turns = Number(arg("turns", "5"));
  const results = [];
  for (const n of arg("sessions", "1,10,25,50").split(",").map(Number)) results.push(await scenario(`concurrency-${n}`, n, turns, base));
  results.push(await scenario("slow-llm-2s-ttft", 10, 3, { ...base, MOCK_LLM_TTFT_MS: "2000" }));
  results.push(await scenario("long-answers", 10, 3, { ...base, MOCK_LLM_REPEAT: "8" }));
  results.push(await scenario("barge-in-50pct", 10, 4, { ...base, MOCK_LLM_REPEAT: "6" }, 0.5));
  results.push(await scenario("llm-outage", 5, 2, { ...base, MOCK_LLM_FAIL: "1" }));
  delete process.env.MOCK_LLM_FAIL;

  // Critical path in the simulation: STT runs during the hangover (speculative), so after
  // end-of-turn: retrieval (real DB) + LLM TTFT + first segment tokens + TTS latency.
  const simFloor = SIM.ttft + SIM.tts;
  console.log("SYNTHETIC LOAD TEST (mock providers; real WebSocket, Postgres/pgvector, orchestration)");
  console.log(`simulated: STT ${SIM.stt} ms, LLM TTFT ${SIM.ttft} ms + ${SIM.token} ms/token, TTS ${SIM.tts} ms → simulated floor ≈ ${simFloor} ms + first-clause tokens\n`);
  for (const r of results) {
    const f = r.eosToFirstAudio;
    console.log(`${r.name.padEnd(20)} sessions ${String(r.sessions).padStart(3)} turns ${String(r.turns).padStart(4)}  EOS→first audio p50 ${f.p50} p95 ${f.p95} p99 ${f.p99} ms · ${JSON.stringify(r.outcomes)} · stale-audio barge-ins ${r.cancelledWithStaleAudio} · ${r.throughputTurnsPerSec} turns/s`);
  }
  fs.mkdirSync("bench-results", { recursive: true });
  const file = path.join("bench-results", `bench-load-SYNTHETIC-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ synthetic: true, simulated: SIM, results }, null, 2));
  console.log(`\nwrote ${file}`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
