// Server-side configuration. Never import this from client components.
// Getters (not constants) so tests can change process.env between cases.
import os from "node:os";
import path from "node:path";

function num(v: string | undefined, d: number, min = 0): number {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
}
function str(v: string | undefined, d: string): string {
  const t = (v ?? "").trim();
  return t === "" ? d : t;
}
function optNum(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function expandHome(p: string) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export const env = {
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
  get port() {
    return num(process.env.PORT, 3100, 1);
  },
  get storageDir() {
    return path.resolve(str(process.env.VOICERAG_STORAGE_DIR, "./storage"));
  },
  get maxUploadBytes() {
    return num(process.env.VOICERAG_MAX_UPLOAD_MB, 20, 1) * 1024 * 1024;
  },
  get retentionDays() {
    return num(process.env.VOICERAG_RETENTION_DAYS, 30, 1);
  },
  get inprocessWorker() {
    return process.env.VOICERAG_INPROCESS_WORKER !== "false";
  },
  get secureCookies() {
    return process.env.NODE_ENV === "production";
  },

  // --- providers ---
  get sttProvider() {
    return str(process.env.STT_PROVIDER, "whispercpp").toLowerCase();
  },
  get whisperUrl() {
    return str(process.env.WHISPERCPP_URL, "http://127.0.0.1:8178");
  },
  get whisperModelPath() {
    return expandHome(str(process.env.WHISPERCPP_MODEL_PATH, "~/.cache/whisper/ggml-base.en.bin"));
  },
  get sttVocabulary() {
    return (process.env.STT_VOCABULARY ?? "").trim().slice(0, 600);
  },
  get speculativePrerender() {
    return process.env.SPECULATIVE_PRERENDER !== "false";
  },
  get sttPartialIntervalMs() {
    return num(process.env.STT_PARTIAL_INTERVAL_MS, 0);
  },
  get llmProvider() {
    return str(process.env.LLM_PROVIDER, "ollama").toLowerCase();
  },
  get llmModel() {
    return str(process.env.LLM_MODEL, "llama3.2:1b");
  },
  /** Local Ollama model used when a cloud LLM is selected but its key is missing ("" disables). */
  get llmFallbackModel() {
    return (process.env.LLM_FALLBACK_MODEL ?? "llama3.2:1b").trim();
  },
  get llmMaxTokens() {
    return num(process.env.LLM_MAX_TOKENS, 160, 16);
  },
  get llmTemperature() {
    return num(process.env.LLM_TEMPERATURE, 0.2);
  },
  /** Ollama context window. Prompts here are ~600–900 tokens; a smaller window means less KV memory. */
  get llmNumCtx() {
    return num(process.env.LLM_NUM_CTX, 2048, 512);
  },
  get llmTimeoutMs() {
    return num(process.env.LLM_TIMEOUT_MS, 15000, 1000);
  },
  get llmPriceInPerMTok() {
    return optNum(process.env.LLM_PRICE_INPUT_PER_MTOK);
  },
  get llmPriceOutPerMTok() {
    return optNum(process.env.LLM_PRICE_OUTPUT_PER_MTOK);
  },
  get ollamaUrl() {
    return str(process.env.OLLAMA_URL, "http://127.0.0.1:11434");
  },
  get anthropicKey() {
    return (process.env.ANTHROPIC_API_KEY ?? "").trim();
  },
  get openaiKey() {
    return (process.env.OPENAI_API_KEY ?? "").trim();
  },
  get geminiKey() {
    return (process.env.GEMINI_API_KEY ?? "").trim();
  },
  get geminiBaseUrl() {
    return str(process.env.GEMINI_BASE_URL, "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
  },
  /** Optional OpenAI-style `reasoning_effort` (e.g. "none" turns off Gemini Flash thinking for speed). */
  get llmReasoningEffort() {
    return (process.env.LLM_REASONING_EFFORT ?? "").trim();
  },
  get openaiBaseUrl() {
    return str(process.env.OPENAI_BASE_URL, "https://api.openai.com/v1").replace(/\/$/, "");
  },
  get embedProvider() {
    return str(process.env.EMBED_PROVIDER, "ollama").toLowerCase();
  },
  get embedModel() {
    return str(process.env.EMBED_MODEL, "nomic-embed-text");
  },
  get embedDim() {
    return num(process.env.EMBED_DIM, 768, 1);
  },
  get ttsProvider() {
    return str(process.env.TTS_PROVIDER, "piper").toLowerCase();
  },
  get ttsVoice() {
    return str(process.env.TTS_VOICE, "alloy");
  },
  get ttsRateWpm() {
    return num(process.env.TTS_RATE_WPM, 180, 80);
  },
  get openaiTtsModel() {
    return str(process.env.OPENAI_TTS_MODEL, "gpt-4o-mini-tts");
  },

  // --- retrieval ---
  /** Allow clearly-labelled general guidance for non-VIH questions with no matching documents. */
  get generalAnswers() {
    return process.env.GENERAL_ANSWERS !== "false";
  },
  get ragTopK() {
    return Math.min(10, num(process.env.RAG_TOP_K, 3, 1));
  },
  get ragCandidates() {
    return Math.min(50, num(process.env.RAG_CANDIDATES, 12, 1));
  },
  get chunkTargetWords() {
    return num(process.env.CHUNK_TARGET_WORDS, 100, 20);
  },
  get chunkOverlapWords() {
    return num(process.env.CHUNK_OVERLAP_WORDS, 20);
  },
  get ragMinVectorSim() {
    return num(process.env.RAG_MIN_VECTOR_SIM, 0.73);
  },
  get ragMinVectorSimWithKeyword() {
    return num(process.env.RAG_MIN_VECTOR_SIM_WITH_KEYWORD, 0.66);
  },
  /**
   * Below the strong thresholds but at or above this cosine similarity, the best passages are still
   * given to the LLM, which answers only if they really answer the question (0 disables).
   */
  get ragMinVectorSimBorderline() {
    return num(process.env.RAG_MIN_VECTOR_SIM_BORDERLINE, 0.6);
  },
  get ragCacheTtlMs() {
    return num(process.env.RAG_CACHE_TTL_SECONDS, 300) * 1000;
  },
  get ragCacheMaxEntries() {
    return num(process.env.RAG_CACHE_MAX_ENTRIES, 500, 1);
  },

  // --- limits ---
  get maxUtteranceSeconds() {
    return num(process.env.VOICE_MAX_UTTERANCE_SECONDS, 30, 1);
  },
  get turnsPerMinute() {
    return num(process.env.VOICE_TURNS_PER_MINUTE, 20, 1);
  },
  get maxSessionsPerUser() {
    return num(process.env.VOICE_MAX_SESSIONS_PER_USER, 3, 1);
  },
};
