// End-to-end voice latency benchmark against a RUNNING server with its configured (real) providers.
//
// Each question is synthesised once to 16 kHz WAV (macOS `say`), then streamed over the voice
// WebSocket in real time (20 ms frames, wall-clock paced) through the same EnergyVad the browser
// uses, so speech_start / pause / speech_end are emitted exactly as a browser would emit them.
//
// Measured on this client's clock:
//   perceived  = last voiced frame sent → first assistant audio frame received
//                (includes the VAD hangover; excludes mic capture + speaker output latency)
//   pipeline   = speech_end sent → first assistant audio frame received
// plus the server's per-stage breakdown from `turn_end`.
//
//   npm run bench:voice -- --rounds 3 [--concurrency 1] [--label baseline] [--base http://localhost:3100]
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { DEFAULT_VAD, EnergyVad, rmsOf } from "../src/shared/vad";
import { decodeAudioFrame, type ServerMsg, type TurnMetricsView } from "../src/shared/protocol";
import { summarize } from "../src/shared/stats";
import { wavToPcm } from "../src/server/providers/types";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", `http://localhost:${process.env.PORT || 3100}`);
const ROUNDS = Number(arg("rounds", "3"));
const CONC = Number(arg("concurrency", "1"));
const LABEL = arg("label", "run");
const EMAIL = arg("email", "admin@vih.test");
const PASSWORD = arg("password", process.env.VOICERAG_SEED_PASSWORD || "change-me-dev-only");
const VOICE = arg("voice", "Samantha");

export const QUESTIONS = [
  "How many days of annual leave do I get each year?",
  "What are the core working hours?",
  "How long is parental leave for the primary caregiver?",
  "What is the minimum password length?",
  "How many approvals does a pull request need?",
  "How quickly must a sev one page be acknowledged?",
  "What is the per diem for international travel?",
  "How many people can be in a single space at once?",
  "How many days a week can I work from home?",
  "What time does the cafeteria open?",
  "What is the dental insurance coverage limit?",
  "Who won the last football world cup?",
];

function synth(text: string): Int16Array {
  const dir = path.resolve("bench-results/audio");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${crypto.createHash("sha1").update(`${VOICE}|${text}`).digest("hex").slice(0, 12)}.wav`);
  if (!fs.existsSync(f)) execFileSync("say", ["-v", VOICE, "-o", f, "--data-format=LEI16@16000", text]);
  const { pcm, sampleRate } = wavToPcm(fs.readFileSync(f));
  if (sampleRate !== 16000) throw new Error(`expected 16 kHz, got ${sampleRate}`);
  // 400 ms leading silence (noise-floor calibration) + speech + 1.5 s trailing silence.
  const out = new Int16Array(6400 + pcm.length + 24000);
  out.set(pcm, 6400);
  // Low-level noise so the VAD sees a realistic floor rather than digital silence.
  for (let i = 0; i < out.length; i++) out[i] += Math.round((Math.random() - 0.5) * 60);
  return out;
}

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const c = r.headers.get("set-cookie")?.split(";")[0];
  if (!c) throw new Error("no session cookie");
  return c;
}

interface TurnResult {
  question: string;
  transcript: string;
  outcome: string;
  perceivedMs: number | null;
  pipelineMs: number | null;
  firstPartialMs: number | null;
  server: TurnMetricsView | null;
  wordAccuracy: number;
  answer: string;
  error?: string;
}

function wordAccuracy(ref: string, hyp: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const r = norm(ref);
  const h = new Set(norm(hyp));
  return r.filter((w) => h.has(w)).length / Math.max(1, r.length);
}

class Client {
  private ws!: WebSocket;
  private listeners: ((m: ServerMsg | { t: "audio"; turnNum: number; at: number }) => void)[] = [];
  constructor(private cookie: string) {}

  async open() {
    const url = `${BASE.replace(/^http/, "ws")}/ws/voice?source=benchmark`;
    this.ws = new WebSocket(url, { headers: { Cookie: this.cookie, Origin: BASE } });
    this.ws.on("message", (data, bin) => {
      const at = performance.now();
      let m: ServerMsg | { t: "audio"; turnNum: number; at: number };
      if (bin) {
        const b = data as Buffer;
        m = { t: "audio", turnNum: decodeAudioFrame(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)!.turnNum, at };
      } else m = JSON.parse(String(data));
      for (const l of [...this.listeners]) l(m);
    });
    await new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.ws.send(JSON.stringify({ t: "hello", config: { speak: true, rateWpm: 180 } }));
    await this.next((m) => m.t === "ready");
  }

  next<T>(pred: (m: ServerMsg | { t: "audio"; turnNum: number; at: number }) => T | false | undefined, timeout = 60_000): Promise<T> {
    return new Promise((res, rej) => {
      const to = setTimeout(() => {
        this.listeners = this.listeners.filter((x) => x !== l);
        rej(new Error("timeout"));
      }, timeout);
      const l = (m: ServerMsg | { t: "audio"; turnNum: number; at: number }) => {
        const v = pred(m);
        if (v) {
          clearTimeout(to);
          this.listeners = this.listeners.filter((x) => x !== l);
          res(v);
        }
      };
      this.listeners.push(l);
    });
  }

  async turn(question: string, pcm: Int16Array): Promise<TurnResult> {
    const vad = new EnergyVad(DEFAULT_VAD);
    const uttId = crypto.randomUUID().slice(0, 8);
    const ring: Buffer[] = [];
    let inUtt = false;
    let ended = false;
    let lastVoiceAt = 0;
    let endSentAt = 0;
    let speechStartAt = 0;
    let firstPartialAt: number | null = null;
    let firstAudioAt: number | null = null;
    let turnNum = -1;
    let turnId = "";
    let transcript = "";
    let answer = "";
    let server: TurnMetricsView | null = null;
    let outcome = "unknown";

    const done = new Promise<void>((resolve) => {
      const l = (m: ServerMsg | { t: "audio"; turnNum: number; at: number }) => {
        if (m.t === "partial" && firstPartialAt === null) firstPartialAt = performance.now();
        if (m.t === "turn_start") {
          turnNum = m.turnNum;
          turnId = m.turnId;
        }
        if (m.t === "transcript") transcript = m.text;
        if (m.t === "audio" && m.turnNum === turnNum && firstAudioAt === null) {
          firstAudioAt = m.at;
          this.ws.send(JSON.stringify({ t: "playback_started", turnId, lastVoiceToAudioMs: Math.round(firstAudioAt - lastVoiceAt), speechStartToAudioMs: Math.round(firstAudioAt - speechStartAt) }));
        }
        if (m.t === "answer_done") answer = m.text;
        if (m.t === "turn_end") {
          server = m.metrics;
          outcome = m.outcome;
          this.listeners = this.listeners.filter((x) => x !== l);
          resolve();
        }
        if (m.t === "error" && (m.code === "NO_SPEECH" || m.code === "STT_FAILED")) {
          outcome = m.code;
          this.listeners = this.listeners.filter((x) => x !== l);
          resolve();
        }
      };
      this.listeners.push(l);
    });

    // Real-time streaming, drift-corrected.
    const FRAME = 320;
    const t0 = performance.now();
    for (let i = 0, f = 0; i < pcm.length && !ended; i += FRAME, f++) {
      const target = t0 + f * 20;
      const wait = target - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const frame = pcm.subarray(i, i + FRAME);
      const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
      const rms = rmsOf(frame);
      const evs = vad.process(rms, 20);
      if (rms > vad.threshold()) lastVoiceAt = performance.now();
      if (inUtt) this.ws.send(buf);
      else {
        ring.push(Buffer.from(buf));
        if (ring.length > 15) ring.shift();
      }
      for (const ev of evs) {
        if (ev.type === "start") {
          inUtt = true;
          speechStartAt = performance.now() - ev.preRollMs;
          this.ws.send(JSON.stringify({ t: "speech_start", uttId }));
          for (const r of ring) this.ws.send(r);
        } else if (ev.type === "pause") this.ws.send(JSON.stringify({ t: "pause", uttId }));
        else if (ev.type === "resume") this.ws.send(JSON.stringify({ t: "resume", uttId }));
        else if (ev.type === "end") {
          endSentAt = performance.now();
          this.ws.send(JSON.stringify({ t: "speech_end", uttId, speechMs: ev.speechMs, hangoverMs: ev.hangoverMs }));
          ended = true;
        } else if (ev.type === "abort") inUtt = false;
      }
    }
    if (!ended) return { question, transcript: "", outcome: "vad_no_end", perceivedMs: null, pipelineMs: null, firstPartialMs: null, server: null, wordAccuracy: 0, answer: "", error: "VAD did not detect end of speech" };
    await Promise.race([done, new Promise((r) => setTimeout(r, 60_000))]);
    return {
      question,
      transcript,
      outcome,
      perceivedMs: firstAudioAt !== null ? Math.round(firstAudioAt - lastVoiceAt) : null,
      pipelineMs: firstAudioAt !== null ? Math.round(firstAudioAt - endSentAt) : null,
      firstPartialMs: firstPartialAt !== null ? Math.round(firstPartialAt - speechStartAt) : null,
      server,
      wordAccuracy: wordAccuracy(question, transcript),
      answer,
    };
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  const cookie = await login();
  const only = arg("only", "");
  const audio = QUESTIONS.filter((q) => !only || only.toLowerCase().split(",").some((o) => q.toLowerCase().includes(o.trim()))).map((q) => ({ q, pcm: synth(q) }));
  const ready = await (await fetch(`${BASE}/api/ready`, { headers: { Cookie: cookie } })).json();
  console.log(`benchmark "${LABEL}" → ${BASE} · rounds ${ROUNDS} · concurrency ${CONC} · ${QUESTIONS.length} questions`);
  console.log(`providers: ${JSON.stringify(ready.providers ? Object.fromEntries(Object.entries(ready.providers).map(([k, v]) => [k, (v as { detail: string }).detail])) : "n/a")}`);

  const results: TurnResult[] = [];
  const workers = await Promise.all(Array.from({ length: CONC }, async () => {
    const c = new Client(cookie);
    await c.open();
    return c;
  }));
  // One untimed warm-up turn per worker (connection + first-request effects).
  await Promise.all(workers.map((w) => w.turn(audio[0].q, audio[0].pcm)));

  const jobs = Array.from({ length: ROUNDS }, () => audio).flat();
  let next = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < jobs.length) {
        const j = jobs[next++];
        try {
          const r = await w.turn(j.q, j.pcm);
          results.push(r);
          process.stdout.write(r.outcome === "answered" || r.outcome === "abstained" ? "." : "x");
        } catch (e) {
          results.push({ question: j.q, transcript: "", outcome: "error", perceivedMs: null, pipelineMs: null, firstPartialMs: null, server: null, wordAccuracy: 0, answer: "", error: String(e) });
          process.stdout.write("E");
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }),
  );
  workers.forEach((w) => w.close());

  const ok = results.filter((r) => r.outcome === "answered" || r.outcome === "abstained");
  const s = (f: (r: TurnResult) => number | null | undefined) => summarize(ok.map((r) => f(r) ?? null));
  const summary = {
    label: LABEL,
    at: new Date().toISOString(),
    host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}` },
    providers: ready.providers,
    rounds: ROUNDS,
    concurrency: CONC,
    turns: results.length,
    succeeded: ok.length,
    failures: results.filter((r) => !ok.includes(r)).map((r) => ({ q: r.question, outcome: r.outcome, error: r.error })),
    perceivedLastVoiceToFirstAudio: s((r) => r.perceivedMs),
    pipelineEosToFirstAudio: s((r) => r.pipelineMs),
    serverEosToFirstAudio: s((r) => r.server?.eosToFirstAudioMs),
    serverEosToTranscript: s((r) => r.server?.eosToTranscriptMs),
    serverEosToEvidence: s((r) => r.server?.eosToEvidenceMs),
    serverEosToFirstToken: s((r) => r.server?.eosToFirstTokenMs),
    sttMs: s((r) => r.server?.sttMs),
    retrievalMs: s((r) => r.server?.retrievalMs),
    llmTtftMs: s((r) => r.server?.llmTtftMs),
    ttsFirstChunkMs: s((r) => r.server?.ttsFirstChunkMs),
    totalMs: s((r) => r.server?.totalMs),
    firstPartialMs: s((r) => r.firstPartialMs),
    speculativeHitRate: ok.filter((r) => r.server?.speculativeHit).length / Math.max(1, ok.length),
    retrievalCacheHitRate: ok.filter((r) => r.server?.retrievalCacheHit).length / Math.max(1, ok.length),
    transcriptWordAccuracy: summarize(ok.map((r) => Math.round(r.wordAccuracy * 100))),
    under500ms: ok.filter((r) => r.perceivedMs !== null && r.perceivedMs < 500).length,
    under1000ms: ok.filter((r) => r.perceivedMs !== null && r.perceivedMs < 1000).length,
    results,
  };
  fs.mkdirSync("bench-results", { recursive: true });
  const file = path.join("bench-results", `bench-voice-${LABEL}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));

  const row = (name: string, x: { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }) => console.log(`${name.padEnd(46)} n=${String(x.n).padStart(3)}  p50 ${String(x.p50).padStart(5)}  p95 ${String(x.p95).padStart(5)}  p99 ${String(x.p99).padStart(5)}  max ${String(x.max).padStart(5)}`);
  console.log(`\n\nsucceeded ${ok.length}/${results.length}`);
  row("PERCEIVED last voice → first audio (ms)", summary.perceivedLastVoiceToFirstAudio);
  row("  of which VAD hangover (fixed)", summarize(ok.map(() => DEFAULT_VAD.hangoverMs)));
  row("speech_end sent → first audio (ms)", summary.pipelineEosToFirstAudio);
  row("server: EOS → transcript", summary.serverEosToTranscript);
  row("server: EOS → evidence", summary.serverEosToEvidence);
  row("server: EOS → first token", summary.serverEosToFirstToken);
  row("server: EOS → first audio", summary.serverEosToFirstAudio);
  row("stage: STT", summary.sttMs);
  row("stage: retrieval", summary.retrievalMs);
  row("stage: LLM TTFT", summary.llmTtftMs);
  row("stage: TTS first chunk", summary.ttsFirstChunkMs);
  row("server: EOS → response complete", summary.totalMs);
  row("speech start → first partial", summary.firstPartialMs);
  console.log(`speculative hit ${(summary.speculativeHitRate * 100).toFixed(0)}% · retrieval cache hit ${(summary.retrievalCacheHitRate * 100).toFixed(0)}% · transcript word accuracy p50 ${summary.transcriptWordAccuracy.p50}% · perceived <500 ms: ${summary.under500ms}/${ok.length} · <1 s: ${summary.under1000ms}/${ok.length}`);
  if (summary.failures.length) console.log("failures:", summary.failures);
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
