// Admin performance dashboard data, computed from recorded TurnMetric rows only.
// Live, benchmark and synthetic-load traffic are reported separately and labelled.
import { prisma } from "@/lib/db";
import { summarize } from "@/shared/stats";
import { cacheStats } from "./rag/retrieve";

const STAGES = [
  ["clientEosToFirstAudioMs", "Perceived: last voiced frame → first audio (browser clock, includes VAD hangover)"],
  ["eosToFirstAudioMs", "End-of-turn → first audio sent (server)"],
  ["speechStartToFirstAudioMs", "Speech start → first audio (browser clock)"],
  ["eosToTranscriptMs", "End-of-turn → final transcript"],
  ["eosToEvidenceMs", "End-of-turn → evidence"],
  ["eosToFirstTokenMs", "End-of-turn → first LLM token"],
  ["sttMs", "STT processing"],
  ["firstPartialMs", "Speech start → first partial transcript"],
  ["retrievalMs", "Retrieval (embed + search)"],
  ["llmTtftMs", "LLM time to first token"],
  ["ttsFirstChunkMs", "TTS first chunk"],
  ["totalMs", "End-of-turn → response complete"],
  ["vadHangoverMs", "VAD hangover (silence wait)"],
] as const;

export async function metricsSummary(opts: { source: string; hours: number }) {
  const since = new Date(Date.now() - opts.hours * 3600_000);
  const rows = await prisma.turnMetric.findMany({ where: { source: opts.source, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 5000 });
  const by = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred);
  const okRows = by((r) => r.outcome === "answered" || r.outcome === "abstained");
  const stage = (subset: typeof rows) =>
    STAGES.map(([key, label]) => ({ key, label, ...summarize(subset.map((r) => r[key] as number | null)) }));
  const rate = (n: number, d: number) => (d ? n / d : null);
  const withRetrieval = rows.filter((r) => r.retrievalCacheHit !== null);
  const voice = rows.filter((r) => r.mode === "voice");
  const costRows = rows.filter((r) => r.costUsd !== null);
  const feedback = await prisma.feedback.groupBy({ by: ["rating"], where: { createdAt: { gte: since } }, _count: true });

  return {
    source: opts.source,
    hours: opts.hours,
    turns: rows.length,
    outcomes: Object.fromEntries(["answered", "abstained", "cancelled", "error", "timeout"].map((o) => [o, rows.filter((r) => r.outcome === o).length])),
    errorRate: rate(rows.filter((r) => r.outcome === "error").length, rows.length),
    timeoutRate: rate(rows.filter((r) => r.outcome === "timeout").length, rows.length),
    retrievalCacheHitRate: rate(withRetrieval.filter((r) => r.retrievalCacheHit).length, withRetrieval.length),
    speculativeHitRate: rate(voice.filter((r) => r.speculativeHit).length, voice.filter((r) => r.speculativeHit !== null).length),
    costPerTurnUsd: costRows.length ? costRows.reduce((a, r) => a + (r.costUsd ?? 0), 0) / costRows.length : null,
    feedback: Object.fromEntries(feedback.map((f) => [f.rating > 0 ? "up" : "down", f._count])),
    stages: { warm: stage(okRows.filter((r) => !r.coldStart)), cold: stage(okRows.filter((r) => r.coldStart)), voice: stage(okRows.filter((r) => r.mode === "voice" && !r.coldStart)), text: stage(okRows.filter((r) => r.mode === "text" && !r.coldStart)) },
    caches: cacheStats(),
    providers: [...new Set(rows.map((r) => JSON.stringify(r.providers)))].slice(0, 5).map((s) => JSON.parse(s)),
    recent: rows.slice(0, 25).map((r) => ({
      turnId: r.turnId,
      at: r.createdAt,
      mode: r.mode,
      outcome: r.outcome,
      coldStart: r.coldStart,
      clientEosToFirstAudioMs: r.clientEosToFirstAudioMs,
      eosToFirstAudioMs: r.eosToFirstAudioMs,
      sttMs: r.sttMs,
      retrievalMs: r.retrievalMs,
      llmTtftMs: r.llmTtftMs,
      ttsFirstChunkMs: r.ttsFirstChunkMs,
      totalMs: r.totalMs,
      speculativeHit: r.speculativeHit,
      retrievalCacheHit: r.retrievalCacheHit,
    })),
  };
}
