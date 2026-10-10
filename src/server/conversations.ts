// Conversation history and per-turn metrics persistence. Conversations are always loaded by
// (id, userId) so one user can never resume or read another user's history (IDOR guard).
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { redactString } from "@/lib/redact";
import type { ChatMessage } from "./providers/types";
import type { TurnResult } from "./voice/turn";
import type { TurnClock } from "./voice/clock";

export async function loadHistory(userId: string, conversationId: string): Promise<ChatMessage[] | null> {
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } });
  if (!conv) return null;
  const msgs = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" }, take: 6, select: { role: true, text: true } });
  return msgs.reverse().map((m) => ({ role: m.role === "USER" ? "user" : "assistant", content: m.text }));
}

export async function saveTurn(input: { userId: string; conversationId: string | null; turnId: string; question: string; result: TurnResult }) {
  const { result } = input;
  return prisma.$transaction(async (tx) => {
    let conversationId = input.conversationId;
    if (conversationId) {
      const owned = await tx.conversation.findFirst({ where: { id: conversationId, userId: input.userId }, select: { id: true } });
      if (!owned) conversationId = null;
    }
    if (!conversationId) {
      const c = await tx.conversation.create({ data: { userId: input.userId, title: input.question.slice(0, 80) } });
      conversationId = c.id;
    } else {
      await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    }
    await tx.message.create({ data: { conversationId, role: "USER", text: input.question.slice(0, 4000), turnId: input.turnId } });
    const cited = new Set(result.cited);
    const msg = await tx.message.create({
      data: {
        conversationId,
        role: "ASSISTANT",
        text: result.answer.slice(0, 8000) || (result.outcome === "cancelled" ? "(interrupted)" : "(no answer)"),
        turnId: input.turnId,
        abstained: result.abstained,
        interrupted: result.outcome === "cancelled",
        citations: {
          create: result.sources
            .filter((s) => cited.has(s.marker))
            .map((s) => ({ chunkId: s.chunkId, documentId: s.documentId, docTitle: s.title, marker: s.marker, page: s.page, heading: s.heading, excerpt: s.excerpt, score: s.score })),
        },
      },
    });
    return { conversationId, messageId: msg.id };
  });
}

function costUsd(usage: TurnResult["usage"]): number | null {
  const pi = env.llmPriceInPerMTok;
  const po = env.llmPriceOutPerMTok;
  if (!usage || pi === null || po === null) return null;
  return (usage.inputTokens * pi + usage.outputTokens * po) / 1_000_000;
}

export interface MetricInput {
  turnId: string;
  userId: string | null;
  conversationId: string | null;
  mode: "voice" | "text";
  source: string;
  coldStart: boolean;
  providers: Record<string, string>;
  clock: TurnClock;
  result: TurnResult;
  speechMs?: number | null;
  vadHangoverMs?: number | null;
  firstPartialMs?: number | null;
}

export function metricRow(m: MetricInput): Prisma.TurnMetricCreateInput {
  const c = m.clock;
  const r = m.result;
  // Audio pre-rendered during the hangover is only *sent* at release: measure what the user gets.
  const firstAudio = c.get("firstAudioSent") !== null ? "firstAudioSent" : c.get("firstAudio") !== null ? "firstAudio" : "speakSent";
  // Stages finished before the end of turn (speculation) count as 0 ms after it, not negative.
  const after = (name: string) => {
    const v = c.since(name);
    return v === null ? null : Math.max(0, v);
  };
  return {
    turnId: m.turnId,
    userId: m.userId,
    conversationId: m.conversationId,
    mode: m.mode,
    source: m.source,
    coldStart: m.coldStart,
    providers: m.providers,
    outcome: r.outcome,
    errorCode: r.errorCode,
    speechMs: m.speechMs ?? null,
    vadHangoverMs: m.vadHangoverMs ?? null,
    sttMs: c.between("sttStart", "sttDone"),
    firstPartialMs: m.firstPartialMs ?? null,
    eosToTranscriptMs: c.get("sttDone") === null ? null : Math.max(0, c.since("sttDone")!),
    retrievalMs: r.retrieval?.timings.totalMs ?? null,
    eosToEvidenceMs: after("evidence"),
    llmTtftMs: c.between("llmStart", "firstToken"),
    eosToFirstTokenMs: after("firstToken"),
    ttsFirstChunkMs: c.between("ttsStart", "firstAudio"),
    eosToFirstAudioMs: after(firstAudio),
    totalMs: after("end"),
    retrievalCacheHit: r.retrieval ? r.retrieval.cacheHit : null,
    speculativeHit: m.mode === "voice" ? r.speculativeHit : null,
    evidenceCount: r.retrieval?.evidence.length ?? null,
    topScore: r.retrieval?.topSim ?? null,
    inputTokens: r.usage?.inputTokens ?? null,
    outputTokens: r.usage?.outputTokens ?? null,
    costUsd: costUsd(r.usage),
    marks: c.toJSON(),
  };
}

/** Fire-and-forget: metrics never block or fail a turn. */
export function saveMetricAsync(m: MetricInput) {
  prisma.turnMetric.create({ data: metricRow(m) }).catch((e) => console.error("[metrics] write failed:", redactString(String(e))));
}

export function saveClientMetricAsync(turnId: string, userId: string, v: { lastVoiceToAudioMs: number | null; speechStartToAudioMs: number | null }) {
  const clamp = (x: number | null) => (x === null || !Number.isFinite(x) || x < 0 || x > 120_000 ? null : Math.round(x));
  // Retry briefly: the client report can arrive before the server row is written.
  const attempt = async (n: number): Promise<void> => {
    const r = await prisma.turnMetric.updateMany({ where: { turnId, userId }, data: { clientEosToFirstAudioMs: clamp(v.lastVoiceToAudioMs), speechStartToFirstAudioMs: clamp(v.speechStartToAudioMs) } });
    if (r.count === 0 && n < 5) {
      await new Promise((res) => setTimeout(res, 400 * (n + 1)));
      return attempt(n + 1);
    }
  };
  attempt(0).catch((e) => console.error("[metrics] client metric failed:", redactString(String(e))));
}
