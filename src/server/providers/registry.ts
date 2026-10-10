// Provider selection from configuration. One instance of each per process, so HTTP keep-alive
// pools and SDK clients are reused across turns. Tests may inject instances with setProviders().
import { env } from "@/lib/env";
import { OpenAiCompatibleEmbed, OllamaEmbed } from "./embed";
import { AnthropicLlm, OllamaLlm, OpenAiCompatibleLlm } from "./llm";
import { MockEmbed, MockLlm, MockStt, MockTts } from "./mock";
import { OpenAiCompatibleStt, WhisperCppStt } from "./stt";
import { OpenAiCompatibleTts, PiperTts } from "./tts";
import type { EmbedProvider, LlmProvider, SttProvider, TtsProvider } from "./types";

export interface Providers {
  stt: SttProvider;
  llm: LlmProvider;
  /** null = no server-side synthesis ("browser" mode: the client speaks with the Web Speech API). */
  tts: TtsProvider | null;
  embed: EmbedProvider;
}

function build(): Providers {
  const stt = ({ whispercpp: () => new WhisperCppStt(), openai: () => new OpenAiCompatibleStt(), mock: () => new MockStt() } as const)[env.sttProvider as "mock"];
  let llm: (() => LlmProvider) | undefined = ({ ollama: () => new OllamaLlm(), anthropic: () => new AnthropicLlm(), openai: () => new OpenAiCompatibleLlm(), gemini: () => new OpenAiCompatibleLlm(env.llmModel, env.geminiBaseUrl, env.geminiKey, "gemini"), mock: () => new MockLlm() } as const)[env.llmProvider as "mock"];
  // A cloud LLM selected without its key falls back to the local model (logged and shown in the UI
  // provider list), so the app keeps working until the key is added and the server restarted.
  const missingKey = (env.llmProvider === "anthropic" && !env.anthropicKey) || (env.llmProvider === "openai" && !env.openaiKey) || (env.llmProvider === "gemini" && !env.geminiKey);
  if (missingKey && env.llmFallbackModel) {
    console.warn(`> LLM_PROVIDER=${env.llmProvider} but its API key is not set: using local Ollama ${env.llmFallbackModel} until it is.`);
    llm = () => new OllamaLlm(env.llmFallbackModel);
  }
  const embed = ({ ollama: () => new OllamaEmbed(), openai: () => new OpenAiCompatibleEmbed(), mock: () => new MockEmbed(env.embedDim) } as const)[env.embedProvider as "mock"];
  const tts = ({ piper: () => new PiperTts(), openai: () => new OpenAiCompatibleTts(), mock: () => new MockTts(), browser: () => null } as const)[env.ttsProvider as "mock"];
  const missing = [!stt && `STT_PROVIDER=${env.sttProvider}`, !llm && `LLM_PROVIDER=${env.llmProvider}`, !embed && `EMBED_PROVIDER=${env.embedProvider}`, tts === undefined && `TTS_PROVIDER=${env.ttsProvider}`].filter(Boolean);
  if (missing.length) throw new Error(`Unknown provider configuration: ${missing.join(", ")}`);
  const p: Providers = { stt: stt(), llm: llm(), embed: embed(), tts: tts() };
  // VOICERAG_ALLOW_MOCK_PROVIDERS exists only for the browser E2E suite (production build + mocks).
  if (env.isProduction && process.env.VOICERAG_ALLOW_MOCK_PROVIDERS !== "true") {
    const mocks = Object.entries(p).filter(([, v]) => v && v.locality === "test");
    if (mocks.length) throw new Error(`Mock providers are not allowed in production: ${mocks.map(([k]) => k).join(", ")}`);
  }
  return p;
}

const g = globalThis as unknown as { __providers?: Providers };

export function providers(): Providers {
  g.__providers ??= build();
  return g.__providers;
}

export function setProviders(p: Partial<Providers> | null) {
  g.__providers = p === null ? undefined : { ...providers(), ...p };
}

export function describeProviders(p = providers()) {
  return {
    stt: `${p.stt.name}:${p.stt.model} (${p.stt.locality})`,
    llm: `${p.llm.name}:${p.llm.model} (${p.llm.locality})`,
    tts: p.tts ? `${p.tts.name}:${p.tts.model} (${p.tts.locality})` : "browser (Web Speech API)",
    embed: `${p.embed.name}:${p.embed.model} (${p.embed.locality})`,
  };
}

export async function providerHealth(p = providers()) {
  const [stt, llm, embed, tts] = await Promise.all([p.stt.health(), p.llm.health(), p.embed.health(), p.tts ? p.tts.health() : Promise.resolve({ ok: true, detail: "browser" })]);
  return { stt, llm, embed, tts };
}

/** Load models/compile kernels before the first user turn (measured separately as cold start). */
export async function warmProviders(p = providers()) {
  const t0 = performance.now();
  await Promise.all([p.stt.warmup(), p.llm.warmup(), p.embed.warmup(), p.tts?.warmup()].map((x) => Promise.resolve(x).catch(() => undefined)));
  return Math.round(performance.now() - t0);
}
