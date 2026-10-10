// Small streaming-HTTP helpers shared by providers. Node's global fetch (undici) keeps
// connections alive and pools them per origin, so repeated provider calls reuse sockets.
import { ProviderError } from "./types";

export async function* readLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf.trim();
  } finally {
    reader.releaseLock();
  }
}

/** Server-sent events → `data:` payloads (stops at [DONE]). */
export async function* sseData(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  for await (const line of readLines(body)) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") return;
    yield d;
  }
}

export async function ensureOk(provider: string, res: Response): Promise<Response> {
  if (res.ok) return res;
  const text = (await res.text().catch(() => "")).slice(0, 300);
  const code = res.status === 401 || res.status === 403 ? "AUTH" : res.status === 429 ? "RATE_LIMITED" : res.status >= 500 ? "UNAVAILABLE" : "BAD_RESPONSE";
  throw new ProviderError(provider, code, `HTTP ${res.status}: ${text}`, code === "RATE_LIMITED" || code === "UNAVAILABLE");
}

export function mapFetchError(provider: string, e: unknown, signal: AbortSignal): never {
  if (e instanceof ProviderError) throw e;
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error && reason.name === "TimeoutError") throw new ProviderError(provider, "TIMEOUT", "timed out", true);
    throw new ProviderError(provider, "CANCELLED", "cancelled");
  }
  throw new ProviderError(provider, "UNAVAILABLE", e instanceof Error ? e.message : String(e), true);
}

/** Re-chunk a byte stream into Int16 PCM arrays, carrying odd bytes across chunk boundaries. */
export async function* pcmChunks(body: ReadableStream<Uint8Array> | null, minSamples = 2048): AsyncGenerator<Int16Array> {
  if (!body) return;
  const reader = body.getReader();
  let pending = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value && value.length) {
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending);
        merged.set(value, pending.length);
        pending = merged;
      }
      const usable = pending.length - (pending.length % 2);
      if (usable >= minSamples * 2 || (done && usable > 0)) {
        const pcm = new Int16Array(usable / 2);
        new Uint8Array(pcm.buffer).set(pending.subarray(0, usable));
        pending = pending.slice(usable);
        yield pcm;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
