// Voice session: one per authenticated WebSocket.
//
// Latency strategy (all measured, see TurnMetric.marks):
//  * Speculative final transcription: when the client VAD reports a pause (silence onset), the
//    buffered utterance is transcribed immediately, overlapping STT with the VAD hangover window.
//    If speech resumes, the speculation is discarded. Otherwise, at end-of-turn the transcript
//    is usually already available.
//  * Speculative pre-rendering: on the speculative transcript the WHOLE turn runs (retrieval →
//    LLM → TTS) with its output held in an OutputGate. Only when the end of turn is confirmed for
//    the same transcript, permission scope and history is the gate released; buffered audio then
//    goes out immediately. Nothing is disclosed for an utterance the user didn't finish, and any
//    mismatch or resumed speech aborts the work.
//  * Barge-in: a new utterance or explicit cancel aborts the active turn's signal, which stops the
//    LLM stream, TTS synthesis and audio forwarding; the client drops stale audio by turn number.
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { env } from "@/lib/env";
import { redactString } from "@/lib/redact";
import type { AuthUser } from "@/lib/session";
import { MIC_SAMPLE_RATE, type ClientConfig, type ClientMsg, type ServerMsg, type TurnMetricsView } from "@/shared/protocol";
import { type Scope, scopeFor } from "../access";
import { auditAsync } from "../audit";
import { loadHistory, metricRow, saveClientMetricAsync, saveMetricAsync, saveTurn } from "../conversations";
import { describeProviders, type Providers } from "../providers/registry";
import type { ChatMessage } from "../providers/types";
import { retrievalQuery } from "../rag/prompt";
import { retrieve } from "../rag/retrieve";
import { TurnClock } from "./clock";
import { OutputGate } from "./gate";
import { runTurn, type TurnResult } from "./turn";

const activeSessions = new Map<string, number>();
let turnsServed = 0;
const turnBuckets = new Map<string, { tokens: number; at: number }>();

function allowTurn(userId: string, kind: "turn" | "speculation" = "turn"): boolean {
  const now = Date.now();
  // Speculative work (STT + pre-rendered turn on every pause) has its own, larger budget: it is
  // normal to pause a few times per question, but it must not be an unmetered path to the LLM.
  const cap = kind === "turn" ? env.turnsPerMinute : env.turnsPerMinute * 3;
  const key = `${kind}:${userId}`;
  const b = turnBuckets.get(key) ?? { tokens: cap, at: now };
  b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 60_000) * cap);
  b.at = now;
  turnBuckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

interface Utterance {
  id: string;
  chunks: Int16Array[];
  samples: number;
  startedAt: number;
  firstPartialMs: number | null;
  partialTimer: NodeJS.Timeout | null;
  partialBusy: boolean;
  spec: Speculation | null;
}

interface Speculation {
  resumed: boolean;
  samples: number;
  sttStart: number;
  sttDone: number | null;
  transcript: Promise<string>;
  /** The whole turn (retrieval → LLM → TTS) pre-rendered behind an OutputGate. */
  turn: Promise<SpecTurn | null>;
  abort: AbortController;
}

interface SpecTurn {
  turnId: string;
  turnNum: number;
  clock: TurnClock;
  gate: OutputGate;
  question: string;
  scopeKey: string;
  historyLen: number;
  done: Promise<TurnResult>;
}

export interface SessionOptions {
  source?: string; // "live" | "benchmark"
}

export class VoiceSession {
  readonly id = randomUUID();
  private config: ClientConfig = { speak: true };
  private conversationId: string | null = null;
  private history: ChatMessage[] = [];
  private utt: Utterance | null = null;
  private active: { turnId: string; abort: AbortController; done: Promise<void> } | null = null;
  private turnNum = 0;
  private closed = false;
  private sttChain: Promise<unknown> = Promise.resolve();
  private source: string;

  constructor(
    private ws: WebSocket,
    private user: AuthUser,
    private providers: Providers,
    opts: SessionOptions = {},
  ) {
    this.source = opts.source ?? "live";
  }

  static canOpen(userId: string) {
    return (activeSessions.get(userId) ?? 0) < env.maxSessionsPerUser;
  }

  start() {
    activeSessions.set(this.user.id, (activeSessions.get(this.user.id) ?? 0) + 1);
    this.ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) this.onAudio(data as Buffer);
        else this.onControl(JSON.parse(String(data)) as ClientMsg);
      } catch (e) {
        this.send({ t: "error", code: "BAD_MESSAGE", message: "Malformed message.", retryable: false });
        console.error("[voice] bad message:", redactString(String(e)));
      }
    });
    this.ws.on("close", () => this.close());
    this.ws.on("error", () => this.close());
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    const left = (activeSessions.get(this.user.id) ?? 1) - 1;
    if (left > 0) activeSessions.set(this.user.id, left);
    else activeSessions.delete(this.user.id);
    this.discardUtterance();
    this.active?.abort.abort();
  }

  /** Run a turn-level task without awaiting it; a failure is reported to the client, never left unhandled. */
  private background(p: Promise<unknown>) {
    p.catch((e) => {
      console.error("[voice] unexpected error:", redactString(String(e)));
      this.send({ t: "error", code: "INTERNAL", message: "Something went wrong. Please try again.", retryable: true });
      this.send({ t: "state", state: "idle" });
    });
  }

  private send(msg: ServerMsg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendAudio(frame: Uint8Array) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(frame, { binary: true });
  }

  // ---------------------------------------------------------------------------------------
  private onControl(msg: ClientMsg) {
    switch (msg.t) {
      case "hello":
        this.config = sanitizeConfig(msg.config);
        void this.resume(msg.conversationId ?? null);
        return;
      case "config":
        this.config = sanitizeConfig(msg.config);
        return;
      case "speech_start":
        // The user started talking: interrupt anything in progress (barge-in).
        this.cancelActive("barge_in");
        this.discardUtterance();
        this.utt = { id: String(msg.uttId).slice(0, 64), chunks: [], samples: 0, startedAt: performance.now(), firstPartialMs: null, partialTimer: null, partialBusy: false, spec: null };
        this.send({ t: "state", state: "listening" });
        if (env.sttPartialIntervalMs > 0) this.utt.partialTimer = setInterval(() => this.partial(), env.sttPartialIntervalMs);
        return;
      case "pause":
        if (this.utt?.id === msg.uttId) this.speculate();
        return;
      case "resume":
        if (this.utt?.id === msg.uttId && this.utt.spec) {
          this.utt.spec.resumed = true;
          killSpec(this.utt.spec);
          this.utt.spec = null;
        }
        return;
      case "speech_end":
        if (this.utt?.id === msg.uttId) this.background(this.endUtterance(msg.speechMs, msg.hangoverMs));
        return;
      case "speech_abort":
        if (this.utt?.id === msg.uttId) {
          this.discardUtterance();
          this.send({ t: "state", state: "idle" });
        }
        return;
      case "text": {
        const text = String(msg.text ?? "").trim().slice(0, 1000);
        if (text) this.background(this.startTurn("text", text, new TurnClock(), { speechMs: null, hangoverMs: null, firstPartialMs: null, sttStart: null, sttDone: null }));
        return;
      }
      case "cancel":
        this.discardUtterance();
        this.cancelActive(msg.reason === "user_stop" ? "user_stop" : "barge_in");
        this.send({ t: "state", state: "idle" });
        return;
      case "playback_started":
        saveClientMetricAsync(String(msg.turnId), this.user.id, { lastVoiceToAudioMs: numOrNull(msg.lastVoiceToAudioMs), speechStartToAudioMs: numOrNull(msg.speechStartToAudioMs) });
        return;
      case "new_conversation":
        this.cancelActive("user_stop");
        this.conversationId = null;
        this.history = [];
        this.send({ t: "ready", sessionId: this.id, conversationId: null, providers: describeProviders(this.providers), ttsMode: this.ttsMode() });
        return;
      case "ping":
        this.send({ t: "pong", ts: Number(msg.ts) || 0 });
        return;
    }
  }

  private ttsMode(): "server" | "browser" | "none" {
    return this.providers.tts ? "server" : "browser";
  }

  private async resume(conversationId: string | null) {
    if (conversationId) {
      const h = await loadHistory(this.user.id, conversationId).catch(() => null);
      if (h) {
        this.conversationId = conversationId;
        this.history = h;
      }
    }
    this.send({ t: "ready", sessionId: this.id, conversationId: this.conversationId, providers: describeProviders(this.providers), ttsMode: this.ttsMode() });
  }

  private onAudio(buf: Buffer) {
    const u = this.utt;
    if (!u || buf.length < 2) return;
    if (u.samples >= env.maxUtteranceSeconds * MIC_SAMPLE_RATE) {
      // Hard cap: treat as end of turn rather than buffering without bound.
      this.background(this.endUtterance(Math.round((u.samples / MIC_SAMPLE_RATE) * 1000), 0));
      return;
    }
    const n = buf.length >> 1;
    const pcm = new Int16Array(n);
    new Uint8Array(pcm.buffer).set(buf.subarray(0, n * 2));
    u.chunks.push(pcm);
    u.samples += n;
  }

  private snapshot(u: Utterance): Int16Array {
    const out = new Int16Array(u.samples);
    let off = 0;
    for (const c of u.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /** Serialise STT calls per session (local whisper.cpp processes one request at a time). */
  private stt(pcm: Int16Array, signal: AbortSignal): Promise<string> {
    const p = this.sttChain.then(() => (signal.aborted ? "" : this.providers.stt.transcribe(pcm, MIC_SAMPLE_RATE, signal)));
    this.sttChain = p.catch(() => undefined);
    return p;
  }

  private partial() {
    const u = this.utt;
    if (!u || u.partialBusy || u.spec || u.samples < MIC_SAMPLE_RATE * 0.8) return;
    u.partialBusy = true;
    const ac = new AbortController();
    this.stt(this.snapshot(u), ac.signal)
      .then((text) => {
        if (this.utt !== u || !text || u.spec) return;
        u.firstPartialMs ??= Math.round(performance.now() - u.startedAt);
        this.send({ t: "partial", uttId: u.id, text });
      })
      .catch(() => undefined)
      .finally(() => (u.partialBusy = false));
  }

  private speculate() {
    const u = this.utt;
    if (!u || u.samples < MIC_SAMPLE_RATE * 0.2) return;
    if (u.spec) killSpec(u.spec);
    if (!allowTurn(this.user.id, "speculation")) return; // over budget: the end of turn still works, just not pre-rendered
    const abort = new AbortController();
    const spec: Speculation = { resumed: false, samples: u.samples, sttStart: performance.now(), sttDone: null, transcript: Promise.resolve(""), turn: Promise.resolve(null), abort };
    spec.transcript = this.stt(this.snapshot(u), abort.signal).then((t) => {
      spec.sttDone = performance.now();
      return t;
    });
    spec.turn = spec.transcript
      .then(async (text): Promise<SpecTurn | null> => {
        if (!text || abort.signal.aborted || !env.speculativePrerender) return null;
        const scope = await scopeFor(this.user.id);
        if (abort.signal.aborted) return null;
        const clock = new TurnClock();
        clock.mark("sttStart", spec.sttStart);
        clock.mark("sttDone", spec.sttDone ?? performance.now());
        const gate = new OutputGate((m) => this.send(m), (f) => this.sendAudio(f), clock);
        const turnId = randomUUID();
        const turnNum = ++this.turnNum;
        const history = [...this.history];
        const done = runTurn(
          { providers: this.providers, retrieve: (sc, q, signal) => retrieve(sc, q, { signal }), emit: gate.emit, sendAudio: gate.audio },
          { turnId, turnNum, mode: "voice", question: text, retrievalQuery: retrievalQuery(text, history), scope, history, speak: this.config.speak, tts: { voice: this.config.voice, rateWpm: this.config.rateWpm }, clock, signal: abort.signal },
        );
        done.catch(() => undefined);
        return { turnId, turnNum, clock, gate, question: text, scopeKey: scope.key, historyLen: history.length, done };
      })
      .catch(() => null);
    u.spec = spec;
  }

  private async endUtterance(speechMs: number, hangoverMs: number) {
    const u = this.utt;
    if (!u) return;
    this.utt = null;
    if (u.partialTimer) clearInterval(u.partialTimer);
    const eos = performance.now();
    const clock = new TurnClock(eos); // anchor: end-of-turn received
    this.send({ t: "state", state: "transcribing" });

    const live = u.spec && !u.spec.resumed ? u.spec : null;
    let specText = "";
    if (live) {
      specText = await live.transcript.catch(() => "");
      // A failure here (e.g. a database error resolving the scope) just means the pre-render is not
      // used: the turn falls through to the normal path below.
      const st = await live.turn.catch(() => null);
      const usable = st && !live.abort.signal.aborted && st.historyLen === this.history.length && (await scopeFor(this.user.id).catch(() => null))?.key === st.scopeKey;
      if (st && usable) return this.releaseTurn(live, st, eos, { speechMs, hangoverMs, firstPartialMs: u.firstPartialMs });
      killSpec(live, st);
    }

    let text = "";
    let sttStart: number | null = null;
    let sttDone: number | null = null;
    try {
      if (live && specText) {
        // Pre-render not usable (disabled, or scope/history changed): still reuse the transcript.
        text = specText;
        sttStart = live.sttStart;
        sttDone = live.sttDone ?? performance.now();
      } else {
        sttStart = performance.now();
        text = await this.stt(this.snapshot(u), AbortSignal.timeout(15_000));
        sttDone = performance.now();
      }
    } catch (e) {
      console.error("[voice] stt failed:", redactString(String(e)));
      this.send({ t: "error", code: "STT_FAILED", message: "Speech recognition is unavailable. You can type your question instead.", retryable: true });
      this.send({ t: "state", state: "idle" });
      return;
    }
    if (!text) {
      this.send({ t: "error", code: "NO_SPEECH", message: "I didn't catch that. Please try again.", retryable: true });
      this.send({ t: "state", state: "idle" });
      return;
    }
    await this.startTurn("voice", text, clock, { speechMs, hangoverMs, firstPartialMs: u.firstPartialMs, sttStart, sttDone });
  }

  /** Release a pre-rendered turn: flush its buffered output and let it continue live. */
  private async releaseTurn(spec: Speculation, st: SpecTurn, eos: number, v: { speechMs: number; hangoverMs: number; firstPartialMs: number | null }) {
    this.cancelActive("superseded");
    if (!allowTurn(this.user.id)) {
      killSpec(spec, st);
      this.send({ t: "error", code: "RATE_LIMITED", message: "You're asking questions faster than allowed. Please wait a moment.", retryable: true });
      this.send({ t: "state", state: "idle" });
      return;
    }
    const coldStart = turnsServed++ === 0;
    st.clock.rebase(eos);
    this.send({ t: "turn_start", turnId: st.turnId, turnNum: st.turnNum, mode: "voice" });
    this.send({ t: "transcript", turnId: st.turnId, text: st.question });
    let done!: () => void;
    this.active = { turnId: st.turnId, abort: spec.abort, done: new Promise<void>((r) => (done = r)) };
    st.gate.release();
    try {
      const result = await st.done;
      result.speculativeHit = true;
      await this.afterTurn(st.turnId, "voice", st.question, st.clock, result, { ...v, coldStart });
    } catch (e) {
      console.error("[voice] turn failed:", redactString(String(e)));
      this.send({ t: "error", code: "INTERNAL", message: "Something went wrong. Please try again.", turnId: st.turnId, retryable: true });
    } finally {
      if (this.active?.turnId === st.turnId) this.active = null;
      done();
      if (!spec.abort.signal.aborted) this.send({ t: "state", state: "idle", turnId: st.turnId });
    }
  }

  private cancelActive(reason: string) {
    if (!this.active) return;
    this.active.abort.abort(new Error(reason));
    auditAsync({ actorId: this.user.id, action: "voice.turn_cancelled", targetType: "Turn", targetId: this.active.turnId, details: { reason } });
    this.active = null;
  }

  private discardUtterance() {
    if (!this.utt) return;
    if (this.utt.partialTimer) clearInterval(this.utt.partialTimer);
    if (this.utt.spec) killSpec(this.utt.spec);
    this.utt = null;
  }

  private async startTurn(
    mode: "voice" | "text",
    question: string,
    clock: TurnClock,
    v: { speechMs: number | null; hangoverMs: number | null; firstPartialMs: number | null; sttStart: number | null; sttDone: number | null },
  ) {
    this.cancelActive("superseded");
    if (!allowTurn(this.user.id)) {
      this.send({ t: "error", code: "RATE_LIMITED", message: "You're asking questions faster than allowed. Please wait a moment.", retryable: true });
      this.send({ t: "state", state: "idle" });
      return;
    }
    const turnId = randomUUID();
    const turnNum = ++this.turnNum;
    const abort = new AbortController();
    // The first turn served by this process is the cold-start sample.
    const coldStart = turnsServed++ === 0;
    if (v.sttStart !== null) clock.mark("sttStart", v.sttStart);
    if (v.sttDone !== null) clock.mark("sttDone", v.sttDone);

    this.send({ t: "turn_start", turnId, turnNum, mode });
    this.send({ t: "transcript", turnId, text: question });

    let done!: () => void;
    this.active = { turnId, abort, done: new Promise<void>((r) => (done = r)) };
    try {
      const scope: Scope = await scopeFor(this.user.id);
      const rq = retrievalQuery(question, this.history);

      const result = await runTurn(
        {
          providers: this.providers,
          retrieve: (s, q, signal) => retrieve(s, q, { signal }),
          emit: (m) => this.send(m),
          sendAudio: (f) => this.sendAudio(f),
        },
        {
          turnId,
          turnNum,
          mode,
          question,
          retrievalQuery: rq,
          scope,
          history: this.history,
          speak: this.config.speak,
          tts: { voice: this.config.voice, rateWpm: this.config.rateWpm },
          clock,
          signal: abort.signal,
        },
      );
      await this.afterTurn(turnId, mode, question, clock, result, { ...v, coldStart });
    } catch (e) {
      console.error("[voice] turn failed:", redactString(String(e)));
      this.send({ t: "error", code: "INTERNAL", message: "Something went wrong. Please try again.", turnId, retryable: true });
    } finally {
      if (this.active?.turnId === turnId) this.active = null;
      done();
      if (!abort.signal.aborted) this.send({ t: "state", state: "idle", turnId });
    }
  }

  private async afterTurn(turnId: string, mode: "voice" | "text", question: string, clock: TurnClock, result: TurnResult, v: { speechMs: number | null; hangoverMs: number | null; firstPartialMs: number | null; coldStart: boolean }) {
    // History for follow-ups (in memory first; persistence never blocks the next turn).
    if (result.outcome !== "error") {
      this.history.push({ role: "user", content: question }, { role: "assistant", content: result.answer || "(interrupted)" });
      this.history = this.history.slice(-8);
    }
    let saved: { conversationId: string; messageId: string } | null = null;
    try {
      saved = await saveTurn({ userId: this.user.id, conversationId: this.conversationId, turnId, question, result });
      this.conversationId = saved.conversationId;
    } catch (e) {
      console.error("[voice] persist failed:", redactString(String(e)));
    }
    this.send({ t: "answer_done", turnId, text: result.answer, cited: result.cited, abstained: result.abstained, grounding: result.grounding, messageId: saved?.messageId ?? null, conversationId: this.conversationId });

    const metric = { turnId, userId: this.user.id, conversationId: this.conversationId, mode, source: this.source, coldStart: v.coldStart, providers: describeProviders(this.providers), clock, result, speechMs: v.speechMs, vadHangoverMs: v.hangoverMs, firstPartialMs: v.firstPartialMs };
    const row = metricRow(metric);
    const view: TurnMetricsView = {
      eosToTranscriptMs: row.eosToTranscriptMs ?? null,
      eosToEvidenceMs: row.eosToEvidenceMs ?? null,
      eosToFirstTokenMs: row.eosToFirstTokenMs ?? null,
      eosToFirstAudioMs: row.eosToFirstAudioMs ?? null,
      sttMs: row.sttMs ?? null,
      retrievalMs: row.retrievalMs ?? null,
      llmTtftMs: row.llmTtftMs ?? null,
      ttsFirstChunkMs: row.ttsFirstChunkMs ?? null,
      totalMs: row.totalMs ?? null,
      retrievalCacheHit: row.retrievalCacheHit ?? null,
      speculativeHit: row.speculativeHit ?? null,
    };
    this.send({ t: "turn_end", turnId, outcome: result.outcome, metrics: view });
    saveMetricAsync(metric);
    auditAsync({ actorId: this.user.id, action: "voice.turn", targetType: "Turn", targetId: turnId, details: { mode, outcome: result.outcome, evidence: result.sources.length, cited: result.cited.length } });
  }
}

/** Abort speculative work and drop anything it buffered. */
function killSpec(spec: Speculation, st?: SpecTurn | null) {
  spec.abort.abort();
  if (st) st.gate.discard();
  else void spec.turn.then((t) => t?.gate.discard(), () => undefined);
}

function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function sanitizeConfig(c: ClientConfig | undefined): ClientConfig {
  const rate = Number(c?.rateWpm);
  return {
    speak: c?.speak !== false,
    voice: typeof c?.voice === "string" ? c.voice.slice(0, 40).replace(/[^\w-]/g, "") : undefined,
    rateWpm: Number.isFinite(rate) ? Math.min(300, Math.max(100, rate)) : undefined,
  };
}

export function sessionStats() {
  return { activeSessions: [...activeSessions.values()].reduce((a, b) => a + b, 0), turnsServed };
}
