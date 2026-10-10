// Deterministic providers for CI and synthetic load tests. Never used in production (the
// registry refuses them when NODE_ENV=production). Latencies are configurable so tests can
// simulate slow or hanging providers; every result here is labelled "test" in the UI and metrics.
import { type EmbedProvider, type LlmEvent, type LlmProvider, type LlmRequest, type SttProvider, type TtsProvider, ProviderError, l2normalize } from "./types";

const ms = (name: string, d: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

function sleep(t: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError("mock", "CANCELLED", "cancelled"));
    const id = setTimeout(resolve, t);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new ProviderError("mock", "CANCELLED", "cancelled"));
      },
      { once: true },
    );
  });
}

// --- "speech" encoding used by tests: text carried inside PCM so mock STT can decode it ----
const MAGIC = 0x5654; // "VT"
export function encodeTextAsPcm(text: string, padSamples = 1600): Int16Array {
  const codes = [...Buffer.from(text, "utf8")];
  const pcm = new Int16Array(2 + codes.length + padSamples);
  pcm[0] = MAGIC;
  pcm[1] = codes.length;
  codes.forEach((c, i) => (pcm[2 + i] = c + 1000)); // offset keeps "audio" above VAD silence
  for (let i = 2 + codes.length; i < pcm.length; i++) pcm[i] = (i % 2 ? 1 : -1) * 3000;
  return pcm;
}
export function decodeTextFromPcm(pcm: Int16Array): string {
  if (pcm.length < 2 || pcm[0] !== MAGIC) return "";
  const n = Math.min(pcm[1], pcm.length - 2);
  return Buffer.from(Array.from(pcm.subarray(2, 2 + n), (x) => x - 1000)).toString("utf8");
}

export class MockStt implements SttProvider {
  name = "mock-stt";
  model = "mock";
  locality = "test" as const;
  calls = 0;
  async transcribe(pcm: Int16Array, _sr: number, signal: AbortSignal) {
    this.calls++;
    await sleep(ms("MOCK_STT_MS", 30), signal);
    // Real microphone audio (browser E2E with a fake capture device) carries no encoded text.
    return decodeTextFromPcm(pcm) || process.env.MOCK_STT_DEFAULT || "";
  }
  async warmup() {}
  async health() {
    return { ok: true, detail: "mock" };
  }
}

/** Answers with the first sentence of evidence [1], citing it — or abstains if there is none. */
export class MockLlm implements LlmProvider {
  name = "mock-llm";
  model = "mock";
  locality = "test" as const;
  lastRequest: LlmRequest | null = null;
  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.lastRequest = req;
    if (process.env.MOCK_LLM_FAIL === "1") throw new ProviderError(this.name, "UNAVAILABLE", "simulated outage", true);
    await sleep(ms("MOCK_LLM_TTFT_MS", 40), signal);
    const last = req.messages[req.messages.length - 1]?.content ?? "";
    const m = /<evidence id="1"[^>]*>\s*([\s\S]*?)<\/evidence>/.exec(last);
    const first = m ? (m[1].split(/(?<=[.!?])\s/)[0] ?? "").trim() : "";
    const answer = first ? `According to the knowledge base, ${first.replace(/[.!?]?$/, "")} [1]. Is there anything else?` : "I don't have enough information in the knowledge base to answer that.";
    const words = answer.split(/(?<= )/);
    const longRepeat = Number(process.env.MOCK_LLM_REPEAT || 1);
    for (let r = 0; r < longRepeat; r++) {
      for (const w of words) {
        yield { type: "token", text: w };
        await sleep(ms("MOCK_LLM_TOKEN_MS", 5), signal);
      }
    }
    yield { type: "usage", inputTokens: Math.ceil((req.system.length + last.length) / 4), outputTokens: words.length * longRepeat };
  }
  async warmup() {}
  async health() {
    return { ok: true, detail: "mock" };
  }
}

export class MockTts implements TtsProvider {
  name = "mock-tts";
  model = "mock";
  locality = "test" as const;
  sampleRate = 16000;
  synthesized: string[] = [];
  async *synthesize(text: string, _o: unknown, signal: AbortSignal): AsyncIterable<Int16Array> {
    this.synthesized.push(text);
    await sleep(ms("MOCK_TTS_MS", 20), signal);
    // ~60 ms of tone per word, in 100 ms chunks.
    const total = Math.max(1, text.split(/\s+/).length) * 960;
    for (let off = 0; off < total; off += 1600) {
      const n = Math.min(1600, total - off);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((off + i) / 8) * 2000);
      yield pcm;
      await sleep(ms("MOCK_TTS_CHUNK_MS", 2), signal);
    }
  }
  async warmup() {}
  async health() {
    return { ok: true, detail: "mock" };
  }
}

/**
 * Feature-hashed bag-of-words embedding (with crude stemming). Deterministic and lexical: good
 * enough to exercise retrieval plumbing, ranking and permission filtering in CI.
 */
export class MockEmbed implements EmbedProvider {
  name = "mock-embed";
  model = "mock-hash-v1";
  locality = "test" as const;
  constructor(public dim = 768) {}
  calls = 0;
  async embed(texts: string[]) {
    this.calls++;
    return texts.map((t) => {
      const v = new Array(this.dim).fill(0);
      for (const raw of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (STOP.has(raw)) continue;
        const w = raw.length > 4 ? raw.replace(/(ing|ed|es|s)$/, "") : raw;
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
        v[Math.abs(h) % this.dim] += 1;
      }
      return l2normalize(v);
    });
  }
  async warmup() {}
  async health() {
    return { ok: true, detail: "mock" };
  }
}

const STOP = new Set("a an and are as at be by can do does for from how i in is it many may much of on or our the to we what when where which who why will with you your".split(" "));
