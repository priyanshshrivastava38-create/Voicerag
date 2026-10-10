// Monotonic index version, part of every retrieval cache key. Bumped inside the same
// transaction that changes which chunks are active, so a cache entry can never outlive the
// data it was computed from by more than the read memo below (and never across this process).
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

let memo: { v: number; at: number } | null = null;
const MEMO_MS = 1000; // other processes (separate worker) are observed within ~1 s

export async function indexVersion(): Promise<number> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.v;
  const row = await prisma.indexState.upsert({ where: { id: 1 }, update: {}, create: { id: 1, version: 1 } });
  memo = { v: row.version, at: Date.now() };
  return row.version;
}

export async function bumpIndexVersion(tx: Prisma.TransactionClient) {
  const row = await tx.indexState.upsert({ where: { id: 1 }, update: { version: { increment: 1 } }, create: { id: 1, version: 2 } });
  memo = null;
  return row.version;
}

export function forgetIndexVersion() {
  memo = null;
}
