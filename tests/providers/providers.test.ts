// Real-provider integration suite (NOT run in CI). Exercises whichever providers .env configures.
//   REAL_PROVIDERS=1 npm run test:providers
// Requires the sidecars (npm run sidecars) and Ollama/API credentials as configured.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { providers } from "@/server/providers/registry";
import { wavToPcm } from "@/server/providers/types";

const run = process.env.REAL_PROVIDERS ? describe : describe.skip;

run("configured real providers", () => {
  it("STT transcribes real speech", async () => {
    const f = path.join(os.tmpdir(), "voicerag-provider-test.wav");
    execFileSync("say", ["-o", f, "--data-format=LEI16@16000", "How many days of annual leave do I get?"]);
    const { pcm, sampleRate } = wavToPcm(fs.readFileSync(f));
    const t0 = performance.now();
    const text = await providers().stt.transcribe(pcm, sampleRate, AbortSignal.timeout(20_000));
    console.log(`STT ${Math.round(performance.now() - t0)} ms: ${text}`);
    expect(text.toLowerCase()).toMatch(/annual leave/);
  });

  it("LLM streams tokens and reports usage", async () => {
    let first: number | null = null;
    let text = "";
    let usage = false;
    const t0 = performance.now();
    for await (const ev of providers().llm.stream({ system: "Answer in five words.", messages: [{ role: "user", content: "Say hello to the team." }], maxTokens: 30, temperature: 0 }, AbortSignal.timeout(30_000))) {
      if (ev.type === "token") {
        first ??= performance.now() - t0;
        text += ev.text;
      } else usage = true;
    }
    console.log(`LLM TTFT ${Math.round(first ?? -1)} ms: ${text}`);
    expect(text.length).toBeGreaterThan(0);
    expect(usage).toBe(true);
  });

  it("LLM generation can be cancelled mid-stream", async () => {
    const ac = new AbortController();
    let n = 0;
    await expect(
      (async () => {
        for await (const ev of providers().llm.stream({ system: "Be verbose.", messages: [{ role: "user", content: "Write a long story about a lighthouse." }], maxTokens: 400, temperature: 0.7 }, ac.signal)) {
          if (ev.type === "token" && ++n === 5) ac.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(n).toBeLessThan(15);
  });

  it("embeddings are normalised and of the configured dimension", async () => {
    const [v] = await providers().embed.embed(["annual leave policy"], "query");
    expect(v.length).toBe(providers().embed.dim);
    expect(Math.hypot(...v)).toBeCloseTo(1, 3);
  });

  it("TTS streams PCM audio", async () => {
    const tts = providers().tts;
    if (!tts) return; // browser TTS mode
    let samples = 0;
    const t0 = performance.now();
    let first: number | null = null;
    for await (const pcm of tts.synthesize("Annual leave is twenty two days per year.", {}, AbortSignal.timeout(15_000))) {
      first ??= performance.now() - t0;
      samples += pcm.length;
    }
    console.log(`TTS first chunk ${Math.round(first ?? -1)} ms, ${(samples / tts.sampleRate).toFixed(2)} s audio`);
    expect(samples / tts.sampleRate).toBeGreaterThan(1);
  });
});
