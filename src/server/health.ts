// Liveness / readiness state shared between the custom server and the Next.js API routes
// (same process, so a globalThis slot is enough).
import { prisma } from "@/lib/db";
import { cacheStats } from "./rag/retrieve";
import { providerHealth } from "./providers/registry";
import { sessionStats } from "./voice/session";

const g = globalThis as unknown as { __ready?: { ready: boolean; warmupMs: number | null; since: number } };

export function setReady(ready: boolean, warmupMs: number | null) {
  g.__ready = { ready, warmupMs, since: Date.now() };
}

export async function readiness() {
  const state = g.__ready ?? { ready: false, warmupMs: null, since: Date.now() };
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  const providers = await providerHealth();
  const providersOk = Object.values(providers).every((h) => h.ok);
  const queue = db ? await prisma.documentVersion.groupBy({ by: ["status"], _count: true }).catch(() => []) : [];
  return {
    ready: state.ready && db && providersOk,
    warm: state.ready,
    warmupMs: state.warmupMs,
    db,
    providers,
    ingestion: Object.fromEntries(queue.map((q) => [q.status, q._count])),
    caches: cacheStats(),
    sessions: sessionStats(),
  };
}
