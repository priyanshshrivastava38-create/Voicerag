import { afterEach, describe, expect, it } from "vitest";
import { decodeAudioFrame, type ServerMsg } from "@/shared/protocol";
import { MockEmbed, MockLlm, MockStt, MockTts } from "@/server/providers/mock";
import { type LlmEvent, type LlmProvider, type LlmRequest, ProviderError } from "@/server/providers/types";
import type { Providers } from "@/server/providers/registry";
import type { Evidence, RetrievalResult } from "@/server/rag/retrieve";
import { ABSTAIN_TEXT } from "@/server/rag/prompt";
import { TurnClock } from "@/server/voice/clock";
import { runTurn, type TurnDeps } from "@/server/voice/turn";

const evidence: Evidence[] = [
  { chunkId: "c1", documentId: "d1", collectionId: "hr", collection: "HR", title: "Leave Policy", text: "Full-time employees receive 22 days of paid annual leave per year. Up to 5 days carry over.", headingPath: "Annual Leave", pageStart: 1, pageEnd: 1, sim: 0.87, keywordCoverage: 1, fused: 1 },
];
const found: RetrievalResult = { evidence, abstain: false, reason: "ok", topSim: 0.87, timings: { embedMs: 1, searchMs: 1, totalMs: 2 }, cacheHit: false, embedCacheHit: false };
const none: RetrievalResult = { evidence: [], abstain: true, reason: "low_relevance", topSim: 0.4, timings: { embedMs: 1, searchMs: 1, totalMs: 2 }, cacheHit: false, embedCacheHit: false };
const scope = { userId: "u", collectionIds: ["hr"], key: "hr" };

function harness(over: Partial<Providers> = {}, retrieval = found) {
  const msgs: ServerMsg[] = [];
  const frames: { turnNum: number; at: number }[] = [];
  const p: Providers = { stt: new MockStt(), llm: new MockLlm(), tts: new MockTts(), embed: new MockEmbed(), ...over };
  const deps: TurnDeps = {
    providers: p,
    retrieve: async () => retrieval,
    emit: (m) => msgs.push(m),
    sendAudio: (f) => frames.push({ turnNum: decodeAudioFrame(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer)!.turnNum, at: performance.now() }),
  };
  const ac = new AbortController();
  const clock = new TurnClock();
  const input = { turnId: "t1", turnNum: 5, mode: "text" as const, question: "How much annual leave?", retrievalQuery: "How much annual leave?", scope, history: [], speak: true, tts: {}, clock, signal: ac.signal };
  return { msgs, frames, p, deps, ac, clock, input };
}

afterEach(() => {
  delete process.env.MOCK_LLM_TOKEN_MS;
  delete process.env.MOCK_LLM_TTFT_MS;
  delete process.env.MOCK_LLM_REPEAT;
  delete process.env.LLM_TIMEOUT_MS;
});

describe("runTurn", () => {
  it("streams evidence, tokens, speech segments and audio frames in order, with citations", async () => {
    const h = harness();
    const r = await runTurn(h.deps, h.input);
    expect(r.outcome).toBe("answered");
    expect(r.answer).toContain("22 days");
    expect(r.cited).toEqual([1]);
    const types = h.msgs.map((m) => m.t);
    expect(types.indexOf("evidence")).toBeLessThan(types.indexOf("token"));
    expect(types).toContain("speak");
    expect(h.frames.length).toBeGreaterThan(0);
    expect(h.frames.every((f) => f.turnNum === 5)).toBe(true);
    for (const k of ["evidence", "firstToken", "ttsStart", "firstAudio", "end"]) expect(h.clock.get(k)).not.toBeNull();
    // Speech starts before generation completes (incremental TTS).
    expect(h.clock.get("firstAudio")!).toBeLessThan(h.clock.get("llmDone")!);
  });

  it("abstains deterministically without calling the LLM when evidence is insufficient", async () => {
    const llm = new MockLlm();
    const h = harness({ llm }, none);
    const r = await runTurn(h.deps, h.input);
    expect(r.outcome).toBe("abstained");
    expect(r.answer).toBe(ABSTAIN_TEXT);
    expect(llm.lastRequest).toBeNull();
    expect(h.frames.length).toBeGreaterThan(0); // the abstention is spoken too
  });

  it("stops generation and audio immediately on cancellation (barge-in)", async () => {
    process.env.MOCK_LLM_TOKEN_MS = "20";
    process.env.MOCK_LLM_REPEAT = "20"; // long answer
    const h = harness();
    const p = runTurn(h.deps, h.input);
    while (!h.frames.length) await new Promise((r) => setTimeout(r, 5));
    h.ac.abort();
    const cancelledAt = performance.now();
    const r = await p;
    const after = h.frames.filter((f) => f.at > cancelledAt);
    await new Promise((res) => setTimeout(res, 100));
    expect(r.outcome).toBe("cancelled");
    expect(after.length).toBe(0);
    expect(h.frames.filter((f) => f.at > cancelledAt).length).toBe(0);
    expect(r.answer.split(" ").length).toBeLessThan(20 * 15); // generation was cut short
  });

  it("retries a transient LLM failure once before any token was streamed", async () => {
    let calls = 0;
    const inner = new MockLlm();
    const flaky: LlmProvider = {
      ...inner,
      name: "flaky",
      model: "m",
      locality: "test",
      warmup: async () => undefined,
      health: async () => ({ ok: true }),
      async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
        if (++calls === 1) throw new ProviderError("flaky", "UNAVAILABLE", "503", true);
        yield* inner.stream(req, signal);
      },
    };
    const h = harness({ llm: flaky });
    const r = await runTurn(h.deps, h.input);
    expect(calls).toBe(2);
    expect(r.outcome).toBe("answered");
  });

  it("reports a non-retryable provider failure without hanging", async () => {
    const broken: LlmProvider = { name: "broken", model: "m", locality: "test", warmup: async () => undefined, health: async () => ({ ok: false }), async *stream() { throw new ProviderError("broken", "AUTH", "bad key"); } };
    const h = harness({ llm: broken });
    const r = await runTurn(h.deps, h.input);
    expect(r.outcome).toBe("error");
    expect(r.errorCode).toBe("broken:AUTH");
    expect(h.msgs.some((m) => m.t === "error" && m.code === "GENERATION_FAILED")).toBe(true);
  });

  it("times out a slow LLM with a bounded deadline", async () => {
    // Real providers wrap each call with withTimeout(signal, LLM_TIMEOUT_MS); this one does the same.
    const slow: LlmProvider = {
      name: "slow", model: "m", locality: "test", warmup: async () => undefined, health: async () => ({ ok: true }),
      async *stream(_req, signal) {
        const { withTimeout } = await import("@/server/providers/types");
        const s = withTimeout(signal, 1000);
        await new Promise((res, rej) => { const t = setTimeout(res, 5000); s.addEventListener("abort", () => { clearTimeout(t); rej(new ProviderError("slow", "TIMEOUT", "timed out", true)); }); });
        yield { type: "token" as const, text: "late" };
      },
    };
    const h = harness({ llm: slow });
    const t0 = performance.now();
    const r = await runTurn(h.deps, h.input);
    expect(performance.now() - t0).toBeLessThan(3500); // one retry at most
    expect(r.outcome).toBe("timeout");
  });

  it("keeps the text answer when speech synthesis fails", async () => {
    const tts = new MockTts();
    tts.synthesize = async function* () {
      throw new ProviderError("mock-tts", "UNAVAILABLE", "down");
    };
    const h = harness({ tts });
    const r = await runTurn(h.deps, h.input);
    expect(r.outcome).toBe("answered");
    expect(r.answer).toContain("22 days");
    expect(h.msgs.some((m) => m.t === "error" && m.code === "TTS_FAILED")).toBe(true);
  });

  it("withholds output that starts leaking the system prompt", async () => {
    const leaky: LlmProvider = { name: "leaky", model: "m", locality: "test", warmup: async () => undefined, health: async () => ({ ok: true }), async *stream() { for (const t of ["My rules: ", "Answer ONLY from the numbered ", "evidence passages ", "and more"]) yield { type: "token" as const, text: t }; } };
    const h = harness({ llm: leaky });
    const r = await runTurn(h.deps, h.input);
    expect(r.errorCode).toBe("OUTPUT_GUARD");
    expect(r.answer).not.toMatch(/numbered evidence/);
    const streamed = h.msgs.filter((m) => m.t === "token").map((m) => (m as { text: string }).text).join("");
    expect(streamed).not.toMatch(/evidence passages/);
  });

  it("answers non-VIH questions with labelled general guidance, never internal ones", async () => {
    const llm = new MockLlm();
    const h = harness({ llm }, none);
    const r = await runTurn(h.deps, { ...h.input, question: "What is retrieval-augmented generation?", retrievalQuery: "What is retrieval-augmented generation?" });
    expect(r.grounding === "general" || r.abstained).toBe(true);
    expect(llm.lastRequest?.system).toMatch(/general, publicly known guidance/);
    expect(r.sources).toHaveLength(0);
    const internal = new MockLlm();
    const h2 = harness({ llm: internal }, none);
    const r2 = await runTurn(h2.deps, { ...h2.input, question: "What is our dental insurance limit?", retrievalQuery: "What is our dental insurance limit?" });
    expect(r2.abstained).toBe(true);
    expect(internal.lastRequest).toBeNull();
  });

  it("text-only turns produce no audio", async () => {
    const h = harness();
    const r = await runTurn(h.deps, { ...h.input, speak: false });
    expect(r.outcome).toBe("answered");
    expect(h.frames).toHaveLength(0);
  });
});
