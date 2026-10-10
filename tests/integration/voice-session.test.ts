// End-to-end voice session over a real WebSocket (mock providers, test database):
// authentication, the full voice turn, speculative transcription, barge-in, persistence.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parse } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { prisma } from "@/lib/db";
import { issueSessionToken, SESSION_COOKIE } from "@/lib/session";
import { providers } from "@/server/providers/registry";
import { encodeTextAsPcm } from "@/server/providers/mock";
import { authorizeUpgrade } from "@/server/voice/upgrade";
import { VoiceSession } from "@/server/voice/session";
import { decodeAudioFrame, type ClientMsg, type ServerMsg } from "@/shared/protocol";
import { seeded } from "./helpers";

let s: Awaited<ReturnType<typeof seeded>>;
let server: Server;
let port: number;
const open: WebSocket[] = [];

beforeAll(async () => {
  s = await seeded();
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((_req, res) => res.end());
  server.on("upgrade", async (req, socket, head) => {
    const d = await authorizeUpgrade(req, parse(req.url ?? "/", true).query);
    if (!d.ok) {
      socket.write(`HTTP/1.1 ${d.status} ${d.reason}\r\n\r\n`);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => new VoiceSession(ws, d.user, providers(), { source: "live" }).start());
  });
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  for (const w of open.splice(0)) w.close();
  delete process.env.MOCK_LLM_REPEAT;
  delete process.env.MOCK_LLM_TOKEN_MS;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

interface Rx {
  ws: WebSocket;
  log: (ServerMsg | { t: "audio"; turnNum: number })[];
  send: (m: ClientMsg) => void;
  waitFor: <T extends ServerMsg["t"]>(t: T, pred?: (m: Extract<ServerMsg, { t: T }>) => boolean, timeout?: number) => Promise<Extract<ServerMsg, { t: T }>>;
}

async function connect(userId: string, opts: { origin?: string } = {}): Promise<Rx> {
  const { token } = await issueSessionToken(userId);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/voice`, { headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: opts.origin ?? `http://127.0.0.1:${port}` } });
  open.push(ws);
  const log: Rx["log"] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const b = data as Buffer;
      const f = decodeAudioFrame(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      log.push({ t: "audio", turnNum: f!.turnNum });
    } else log.push(JSON.parse(String(data)));
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const waitFor: Rx["waitFor"] = (t, pred, timeout = 10_000) =>
    new Promise((res, rej) => {
      const deadline = setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), timeout);
      const check = () => {
        const m = log.find((x) => x.t === t && (!pred || pred(x as never)));
        if (m) {
          clearTimeout(deadline);
          res(m as never);
        } else waiters.push(check);
      };
      check();
    });
  return { ws, log, send: (m) => ws.send(JSON.stringify(m)), waitFor };
}

function speak(rx: Rx, uttId: string, text: string) {
  rx.send({ t: "speech_start", uttId });
  const pcm = encodeTextAsPcm(text, 16000); // ~1 s of "speech"
  rx.ws.send(Buffer.from(pcm.buffer));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("voice WebSocket", () => {
  it("rejects unauthenticated and cross-origin upgrades", async () => {
    const anon = new WebSocket(`ws://127.0.0.1:${port}/ws/voice`);
    await expect(new Promise((res, rej) => { anon.once("open", res); anon.once("error", rej); })).rejects.toThrow(/401/);
    const { token } = await issueSessionToken(s.alice.id);
    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws/voice`, { headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: "https://evil.example" } });
    await expect(new Promise((res, rej) => { evil.once("open", res); evil.once("error", rej); })).rejects.toThrow(/403/);
  });

  it("runs a complete voice turn: speculative STT → retrieval → streamed answer → audio → persistence", async () => {
    const rx = await connect(s.alice.id);
    rx.send({ t: "hello", config: { speak: true } });
    await rx.waitFor("ready");
    speak(rx, "u1", "How many days of annual leave do I get each year?");
    rx.send({ t: "pause", uttId: "u1" });
    await sleep(150); // speculative transcription + retrieval run during the "hangover"
    rx.send({ t: "speech_end", uttId: "u1", speechMs: 2000, hangoverMs: 550 });

    const tr = await rx.waitFor("transcript");
    expect(tr.text).toBe("How many days of annual leave do I get each year?");
    const ev = await rx.waitFor("evidence");
    expect(ev.abstain).toBe(false);
    expect(ev.sources[0].title).toBe("Leave and Time Off Policy");
    expect(ev.sources[0].page).toBe(1);
    const done = await rx.waitFor("answer_done");
    expect(done.text).toContain("22 days");
    expect(done.cited).toContain(1);
    expect(done.messageId).toBeTruthy();
    const end = await rx.waitFor("turn_end");
    expect(end.outcome).toBe("answered");
    expect(end.metrics.speculativeHit).toBe(true);
    expect(end.metrics.eosToFirstAudioMs).not.toBeNull();
    const ts = await rx.waitFor("turn_start");
    expect(rx.log.some((m) => m.t === "audio" && m.turnNum === ts.turnNum)).toBe(true);
    // Ordering: evidence is only disclosed after the transcript (end of turn) — never during speculation.
    const idx = (t: string) => rx.log.findIndex((m) => m.t === t);
    expect(idx("evidence")).toBeGreaterThan(idx("transcript"));
    // Pre-rendered audio is held until the turn is released after end-of-turn.
    expect(idx("audio")).toBeGreaterThan(idx("turn_start"));

    const msg = await prisma.message.findUniqueOrThrow({ where: { id: done.messageId! }, include: { citations: true } });
    expect(msg.citations[0]).toMatchObject({ docTitle: "Leave and Time Off Policy", marker: 1 });
    rx.send({ t: "playback_started", turnId: tr.turnId, lastVoiceToAudioMs: 812, speechStartToAudioMs: 2900 });
    let metric = null;
    for (let i = 0; i < 20 && !metric?.clientEosToFirstAudioMs; i++) {
      await sleep(150);
      metric = await prisma.turnMetric.findUnique({ where: { turnId: tr.turnId } });
    }
    expect(metric).toMatchObject({ mode: "voice", outcome: "answered", speculativeHit: true, clientEosToFirstAudioMs: 812, vadHangoverMs: 550 });
    // Generation started during the silence window, before end-of-turn (negative mark)…
    expect((metric!.marks as Record<string, number>).llmStart).toBeLessThan(0);
    // …yet no answer token was disclosed before the transcript was final.
    expect(idx("token")).toBeGreaterThan(idx("transcript"));
  });

  it("discards speculation when the user resumes speaking", async () => {
    const rx = await connect(s.alice.id);
    rx.send({ t: "hello", config: { speak: false } });
    await rx.waitFor("ready");
    speak(rx, "u2", "How many characters must passwords have?");
    rx.send({ t: "pause", uttId: "u2" });
    await sleep(80);
    rx.send({ t: "resume", uttId: "u2" });
    rx.send({ t: "speech_end", uttId: "u2", speechMs: 1500, hangoverMs: 550 });
    const end = await rx.waitFor("turn_end");
    expect(end.metrics.speculativeHit).toBe(false);
    expect((await rx.waitFor("answer_done")).text).toContain("14");
  });

  it("barge-in cancels the active turn and no stale audio is sent afterwards", async () => {
    process.env.MOCK_LLM_REPEAT = "30";
    process.env.MOCK_LLM_TOKEN_MS = "15";
    const rx = await connect(s.alice.id);
    rx.send({ t: "hello", config: { speak: true } });
    await rx.waitFor("ready");
    rx.send({ t: "text", text: "How many days of annual leave do I get each year?" });
    const first = await rx.waitFor("turn_start");
    while (!rx.log.some((m) => m.t === "audio")) await sleep(10);
    speak(rx, "u3", "How many characters must passwords have?"); // user talks over the assistant
    const cut = rx.log.length;
    await rx.waitFor("state", (m) => m.state === "listening");
    const listenIdx = rx.log.findIndex((m, i) => i >= cut - 1 && m.t === "state" && m.state === "listening");
    process.env.MOCK_LLM_REPEAT = "1"; // the follow-up turn gets a normal-length answer
    rx.send({ t: "speech_end", uttId: "u3", speechMs: 1200, hangoverMs: 550 });
    const end1 = await rx.waitFor("turn_end", (m) => m.turnId === first.turnId);
    expect(end1.outcome).toBe("cancelled");
    const second = await rx.waitFor("turn_end", (m) => m.turnId !== first.turnId);
    expect(second.outcome).toBe("answered");
    const staleAfterCancel = rx.log.slice(listenIdx + 1).filter((m) => m.t === "audio" && m.turnNum === first.turnNum);
    expect(staleAfterCancel).toHaveLength(0);
    const interrupted = await prisma.message.findFirst({ where: { turnId: first.turnId, role: "ASSISTANT" } });
    expect(interrupted?.interrupted).toBe(true);
  });

  it("keeps follow-up context and refuses to resume another user's conversation", async () => {
    const rx = await connect(s.alice.id);
    rx.send({ t: "hello", config: { speak: false } });
    await rx.waitFor("ready");
    rx.send({ t: "text", text: "How many days of annual leave do I get each year?" });
    const d1 = await rx.waitFor("answer_done");
    rx.send({ t: "text", text: "And can they carry over?" });
    const d2 = await rx.waitFor("answer_done", (m) => m.turnId !== d1.turnId);
    expect(d2.conversationId).toBe(d1.conversationId);
    expect((await prisma.message.count({ where: { conversationId: d1.conversationId! } }))).toBe(4);

    const intruder = await connect(s.bob.id);
    intruder.send({ t: "hello", config: { speak: false }, conversationId: d1.conversationId });
    const ready = await intruder.waitFor("ready");
    expect(ready.conversationId).toBeNull();
  });

  it("answers users without grants with an explicit no-access message", async () => {
    const rx = await connect(s.carol.id);
    rx.send({ t: "hello", config: { speak: false } });
    await rx.waitFor("ready");
    rx.send({ t: "text", text: "How many days of annual leave do I get?" });
    const d = await rx.waitFor("answer_done");
    expect(d.abstained).toBe(true);
    expect(d.text).toMatch(/can't search any knowledge collections/);
    const ev = await rx.waitFor("evidence");
    expect(ev.sources).toHaveLength(0);
  });
});
