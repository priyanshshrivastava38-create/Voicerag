// Text-to-speech providers. Each sentence is synthesised separately and streamed as PCM16, so
// the first sentence can play while the LLM is still generating the rest.
//  - piper:  local Piper sidecar (scripts/tts_server.py). Text never leaves the host.
//  - openai: OpenAI-compatible /audio/speech with response_format=pcm (24 kHz streaming).
import { env } from "@/lib/env";
import { ensureOk, mapFetchError, pcmChunks } from "./http";
import { type Health, type TtsOptions, type TtsProvider, ProviderError, withTimeout } from "./types";

const TTS_TIMEOUT_MS = 10_000;
const BASE_WPM = 170; // Piper's natural pace at length_scale 1.0 (approximate)

export class PiperTts implements TtsProvider {
  name = "piper";
  locality = "local" as const;
  sampleRate = 22050;
  constructor(
    private url = process.env.PIPER_URL || "http://127.0.0.1:8179",
    public model = (process.env.PIPER_MODEL_PATH || "en_US-lessac-medium.onnx").split("/").pop()!,
  ) {}

  async *synthesize(text: string, opts: TtsOptions, signal: AbortSignal): AsyncIterable<Int16Array> {
    const s = withTimeout(signal, TTS_TIMEOUT_MS);
    const wpm = opts.rateWpm ?? env.ttsRateWpm;
    try {
      const res = await ensureOk(
        this.name,
        await fetch(`${this.url}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, length_scale: BASE_WPM / Math.max(80, Math.min(320, wpm)) }),
          signal: s,
        }),
      );
      const sr = Number(res.headers.get("x-sample-rate"));
      if (sr) this.sampleRate = sr;
      yield* pcmChunks(res.body, 4096);
    } catch (e) {
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {
    const ac = new AbortController();
    for await (const _ of this.synthesize("Hello.", {}, ac.signal)) void _;
  }

  async health(): Promise<Health> {
    try {
      const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1500) });
      const j = (await r.json()) as { sample_rate?: number; voice?: string };
      if (j.sample_rate) this.sampleRate = j.sample_rate;
      return { ok: r.ok, detail: `piper ${j.voice ?? ""} @ ${j.sample_rate ?? "?"} Hz` };
    } catch {
      return { ok: false, detail: `Piper sidecar not reachable at ${this.url} (run: npm run tts:server)` };
    }
  }
}

export class OpenAiCompatibleTts implements TtsProvider {
  name = "openai-tts";
  locality = "cloud" as const;
  sampleRate = 24000;
  constructor(
    public model = env.openaiTtsModel,
    private baseUrl = env.openaiBaseUrl,
    private apiKey = env.openaiKey,
  ) {}

  async *synthesize(text: string, opts: TtsOptions, signal: AbortSignal): AsyncIterable<Int16Array> {
    if (!this.apiKey) throw new ProviderError(this.name, "AUTH", "OPENAI_API_KEY is not configured");
    const s = withTimeout(signal, TTS_TIMEOUT_MS);
    try {
      const res = await ensureOk(
        this.name,
        await fetch(`${this.baseUrl}/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            voice: opts.voice && /^[a-z]+$/.test(opts.voice) ? opts.voice : "alloy",
            input: text,
            response_format: "pcm",
            speed: Math.max(0.5, Math.min(2, (opts.rateWpm ?? env.ttsRateWpm) / BASE_WPM)),
          }),
          signal: s,
        }),
      );
      yield* pcmChunks(res.body, 2400);
    } catch (e) {
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {}

  async health(): Promise<Health> {
    return this.apiKey ? { ok: true, detail: `${this.baseUrl} (not probed)` } : { ok: false, detail: "OPENAI_API_KEY missing" };
  }
}
