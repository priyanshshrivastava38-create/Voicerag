// Test environment: disposable test database and deterministic mock providers.
// The real-provider suite (tests/providers) opts back into configured providers itself.
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.DATABASE_URL_TEST) throw new Error("DATABASE_URL_TEST must point at a disposable database for tests.");
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.VOICERAG_STORAGE_DIR = "./storage/test";

if (!process.env.REAL_PROVIDERS) {
  process.env.STT_PROVIDER = "mock";
  process.env.LLM_PROVIDER = "mock";
  process.env.TTS_PROVIDER = "mock";
  process.env.EMBED_PROVIDER = "mock";
  // Mock (hashed bag-of-words) similarities are lower than neural ones; test thresholds.
  process.env.RAG_MIN_VECTOR_SIM = "0.45";
  process.env.RAG_MIN_VECTOR_SIM_WITH_KEYWORD = "0.25";
}
process.env.STT_PARTIAL_INTERVAL_MS = "0";
process.env.VOICE_TURNS_PER_MINUTE = "1000";
