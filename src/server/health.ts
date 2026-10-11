// Liveness / readiness state shared between the custom server and the Next.js API routes
// (same process, so a globalThis slot is enough).
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { cacheStats } from "./rag/retrieve";
import { providerHealth } from "./providers/registry";
import { sessionStats } from "./voice/session";

const g = globalThis as unknown as { __ready?: { ready: boolean; warmupMs: number | null; since: number } };

export function setReady(ready: boolean, warmupMs: number | null) {
  g.__ready = { ready, warmupMs, since: Date.now() };
  cached = null; // a state change (warm-up done, shutdown) is visible immediately
}

// /api/ready is polled by load balancers and uptime checks; probing every provider (including a
// paid cloud LLM) on each poll is wasteful, so results are reused briefly.
const READY_TTL_MS = 5_000;
let cached: { at: number; value: Promise<Awaited<ReturnType<typeof computeReadiness>>> } | null = null;

export function readiness() {
  const now = Date.now();
  if (!cached || now - cached.at > READY_TTL_MS) cached = { at: now, value: computeReadiness() };
  return cached.value;
}

async function computeReadiness() {
  const state = g.__ready ?? { ready: false, warmupMs: null, since: Date.now() };
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  // On Vercel this process is only the web UI: the voice server (and its providers) is elsewhere.
  const remote = process.env.VERCEL ? await voiceServerHealth() : null;
  const providers = remote ? { voiceServer: remote } : await providerHealth();
  const providersOk = Object.values(providers).every((h) => h.ok);
  const warm = remote ? remote.ok : state.ready;
  const queue = db ? await prisma.documentVersion.groupBy({ by: ["status"], _count: true }).catch(() => []) : [];
  return {
    ready: warm && db && providersOk,
    warm,
    warmupMs: state.warmupMs,
    db,
    providers,
    ingestion: Object.fromEntries(queue.map((q) => [q.status, q._count])),
    caches: cacheStats(),
    sessions: sessionStats(),
  };
}

async function voiceServerHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!env.voiceServerUrl) return { ok: false, detail: "VOICE_SERVER_URL is not set" };
  try {
    const r = await fetch(`${env.voiceServerUrl}/api/ready`, { signal: AbortSignal.timeout(4000), cache: "no-store" });
    return { ok: r.ok, detail: `${env.voiceServerUrl} (${r.ok ? "ready" : `HTTP ${r.status}`})` };
  } catch (e) {
    return { ok: false, detail: `${env.voiceServerUrl} unreachable (${e instanceof Error ? e.message : String(e)})` };
  }
}
