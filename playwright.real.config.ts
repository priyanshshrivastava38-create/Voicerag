// Opt-in: drives an ALREADY RUNNING server with REAL providers from a real Chromium session.
//   npm start  (with sidecars)  then  npx playwright test -c playwright.real.config.ts
import path from "node:path";
import { defineConfig } from "@playwright/test";

const wav = path.resolve("tests/e2e/fixtures/question-long-pause.wav");
export default defineConfig({
  testDir: "tests/e2e-real",
  timeout: 180_000,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"] },
  },
});
