// Browser E2E: real Chromium, real microphone pipeline (fake capture device fed from a WAV),
// real WebSocket/playback code, production build — with MOCK model providers on the TEST database.
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const PORT = 3200;
const wav = path.resolve("tests/e2e/fixtures/question.wav");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  workers: 1,
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: {
    command: "tsx server.ts",
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: "production",
      PORT: String(PORT),
      DATABASE_URL: process.env.DATABASE_URL_TEST ?? "",
      VOICERAG_ALLOW_MOCK_PROVIDERS: "true",
      VOICERAG_STORAGE_DIR: "./storage/test",
      STT_PROVIDER: "mock",
      LLM_PROVIDER: "mock",
      TTS_PROVIDER: "mock",
      EMBED_PROVIDER: "mock",
      MOCK_STT_DEFAULT: "How many days of annual leave do I get each year?",
      MOCK_LLM_REPEAT: "4",
      MOCK_LLM_TOKEN_MS: "40",
      RAG_MIN_VECTOR_SIM: "0.45",
      RAG_MIN_VECTOR_SIM_WITH_KEYWORD: "0.25",
      STT_PARTIAL_INTERVAL_MS: "0",
      VOICE_TURNS_PER_MINUTE: "1000",
    },
  },
});
