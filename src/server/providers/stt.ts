// Speech-to-text providers.
//  - whispercpp: local whisper.cpp HTTP server (scripts/stt-server.sh). Audio never leaves the host.
//  - openai:     any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, a self-hosted
//                faster-whisper server…). Sends audio to that endpoint: requires approval.
import { env } from "@/lib/env";
import { ensureOk, mapFetchError } from "./http";
import { type Health, type SttProvider, ProviderError, pcmToWav, withTimeout } from "./types";

const STT_TIMEOUT_MS = 10_000;

/** Whisper hallucinates these on silence/noise; treat them as empty transcripts. */
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|you\.?|thank you\.?|thanks for watching!?|\.+)\s*$/i;

export function cleanTranscript(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  return NON_SPEECH.test(s) ? "" : s;
}

export class WhisperCppStt implements SttProvider {
  name = "whispercpp";
  locality = "local" as const;
  constructor(
    private url = env.whisperUrl,
    public model = env.whisperModelPath.split("/").pop() ?? "whisper",
  ) {}

  async transcribe(pcm: Int16Array, sampleRate: number, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([pcmToWav(pcm, sampleRate)], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    form.append("language", "en");
    // Domain vocabulary biases decoding toward organisation terms ("per diem", "SEV1", …).
    if (env.sttVocabulary) form.append("prompt", env.sttVocabulary);
    const s = withTimeout(signal, STT_TIMEOUT_MS);
    try {
      const res = await ensureOk(this.name, await fetch(`${this.url}/inference`, { method: "POST", body: form, signal: s }));
      const j = (await res.json()) as { text?: string };
      return cleanTranscript(j.text ?? "");
    } catch (e) {
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {
    // 0.5 s of silence: forces model load + Metal kernel compilation before the first user turn.
    await this.transcribe(new Int16Array(8000), 16000, AbortSignal.timeout(20_000)).catch(() => undefined);
  }

  async health(): Promise<Health> {
    try {
      const r = await fetch(`${this.url}/`, { signal: AbortSignal.timeout(1500) });
      return { ok: r.status < 500, detail: `whisper.cpp at ${this.url}` };
    } catch {
      return { ok: false, detail: `whisper.cpp server not reachable at ${this.url} (run: npm run stt:server)` };
    }
  }
}

export class OpenAiCompatibleStt implements SttProvider {
  name = "openai-stt";
  locality = "cloud" as const;
  constructor(
    public model = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe",
    private baseUrl = env.openaiBaseUrl,
    private apiKey = env.openaiKey,
  ) {}

  async transcribe(pcm: Int16Array, sampleRate: number, signal: AbortSignal): Promise<string> {
    if (!this.apiKey) throw new ProviderError(this.name, "AUTH", "OPENAI_API_KEY is not configured");
    const form = new FormData();
    form.append("file", new Blob([pcmToWav(pcm, sampleRate)], { type: "audio/wav" }), "audio.wav");
    form.append("model", this.model);
    form.append("response_format", "json");
    form.append("language", "en");
    if (env.sttVocabulary) form.append("prompt", env.sttVocabulary);
    const s = withTimeout(signal, STT_TIMEOUT_MS);
    try {
      const res = await ensureOk(
        this.name,
        await fetch(`${this.baseUrl}/audio/transcriptions`, { method: "POST", body: form, headers: { Authorization: `Bearer ${this.apiKey}` }, signal: s }),
      );
      return cleanTranscript(((await res.json()) as { text?: string }).text ?? "");
    } catch (e) {
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {}

  async health(): Promise<Health> {
    return this.apiKey ? { ok: true, detail: `${this.baseUrl} (not probed)` } : { ok: false, detail: "OPENAI_API_KEY missing" };
  }
}
