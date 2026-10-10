// Provider abstractions. Every stage of the voice pipeline talks to one of these interfaces;
// concrete vendors are selected by configuration in ./registry.ts. Model identifiers come from
// configuration only — nothing else in the codebase names a vendor model.

export interface ProviderInfo {
  /** Stable provider key, e.g. "ollama", "whispercpp". */
  name: string;
  /** Model/voice identifier as configured. */
  model: string;
  /** Where data goes: "local" (this host), "cloud" (third party), "test". Surfaced in the UI. */
  locality: "local" | "cloud" | "test";
}

export interface Health {
  ok: boolean;
  detail?: string;
}

export interface SttProvider extends ProviderInfo {
  /** Transcribe a complete mono PCM16 clip. Must honour `signal`. */
  transcribe(pcm: Int16Array, sampleRate: number, signal: AbortSignal): Promise<string>;
  warmup(): Promise<void>;
  health(): Promise<Health>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
}

export type LlmEvent = { type: "token"; text: string } | { type: "usage"; inputTokens: number; outputTokens: number };

export interface LlmProvider extends ProviderInfo {
  stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
  warmup(): Promise<void>;
  health(): Promise<Health>;
}

export interface TtsOptions {
  voice?: string;
  rateWpm?: number;
}

export interface TtsProvider extends ProviderInfo {
  sampleRate: number;
  /** Yields PCM16 mono chunks as soon as they are available. Must honour `signal`. */
  synthesize(text: string, opts: TtsOptions, signal: AbortSignal): AsyncIterable<Int16Array>;
  warmup(): Promise<void>;
  health(): Promise<Health>;
}

export interface EmbedProvider extends ProviderInfo {
  dim: number;
  /** Returns L2-normalised vectors. `kind` lets asymmetric models add query/document prefixes. */
  embed(texts: string[], kind: "query" | "document", signal?: AbortSignal): Promise<number[][]>;
  warmup(): Promise<void>;
  health(): Promise<Health>;
}

/**
 * Realtime speech-to-speech (architecture option B): a single model consumes microphone audio
 * and produces speech, calling `search_knowledge` as a tool for grounded retrieval. Defined so a
 * vendor implementation can be benchmarked against the modular pipeline; no implementation ships
 * because no realtime-audio credentials were available (see docs/ARCHITECTURE.md#option-b).
 */
export interface RealtimeSpeechProvider extends ProviderInfo {
  connect(opts: {
    instructions: string;
    tools: { name: string; description: string; parameters: object }[];
    onAudio: (pcm: Int16Array, sampleRate: number) => void;
    onTranscript: (role: "user" | "assistant", text: string, final: boolean) => void;
    onToolCall: (name: string, args: unknown) => Promise<unknown>;
    signal: AbortSignal;
  }): Promise<{ sendAudio(pcm: Int16Array): void; interrupt(): void; close(): void }>;
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public code: "TIMEOUT" | "UNAVAILABLE" | "BAD_RESPONSE" | "RATE_LIMITED" | "AUTH" | "CANCELLED",
    message: string,
    public retryable = false,
  ) {
    super(`[${provider}] ${message}`);
  }
}

/** Combine a caller signal with a timeout; the returned signal aborts on whichever fires first. */
export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/**
 * Inactivity deadline for streams: aborts if no progress is reported for `ms` (first byte, then
 * between chunks). Long answers that keep streaming are never cut off; stalled ones are.
 */
export function idleTimeout(signal: AbortSignal, ms: number) {
  const ac = new AbortController();
  let timer: NodeJS.Timeout;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new DOMException("stream idle timeout", "TimeoutError")), ms);
    timer.unref?.();
  };
  const onAbort = () => ac.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  arm();
  return {
    signal: ac.signal,
    touch: arm,
    clear: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError" || (e instanceof ProviderError && e.code === "CANCELLED"));
}

export function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

/** Minimal WAV (RIFF, PCM16 mono) encoder for STT uploads. */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = pcm.byteLength;
  const buf = new Uint8Array(44 + dataBytes);
  const dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, dataBytes, true);
  buf.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), 44);
  return buf;
}

/** Parse a PCM16 WAV produced by our own tools (finds the "data" chunk). */
export function wavToPcm(buf: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let off = 12;
  let sampleRate = 0;
  let bits = 16;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    if (id === "fmt ") {
      sampleRate = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`Unsupported WAV bit depth ${bits}`);
      const len = Math.min(size, buf.length - off - 8) >> 1;
      const pcm = new Int16Array(len);
      new Uint8Array(pcm.buffer).set(buf.subarray(off + 8, off + 8 + len * 2));
      return { pcm, sampleRate };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}
