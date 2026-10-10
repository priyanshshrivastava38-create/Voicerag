// Authorization scope: the set of collections a user may retrieve from. Computed server-side on
// every turn from group grants (cached for a few seconds), never taken from the client.
// Admins manage all collections but retrieve only from collections granted to their groups —
// management rights do not silently widen what the assistant may say to them.
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { TtlLru } from "@/lib/lru";
import type { AuthUser } from "@/lib/session";

export interface Scope {
  userId: string;
  collectionIds: string[];
  /** Stable key for authorization-aware caching. */
  key: string;
  /** Display names of the searchable collections (used to tell users what they can ask about). */
  collectionNames?: string[];
}

const scopeCache = new TtlLru<Scope>("scope", 1000, 5_000);

export async function scopeFor(userId: string): Promise<Scope> {
  const hit = scopeCache.get(userId);
  if (hit) return hit;
  const rows = await prisma.collectionGrant.findMany({
    where: { group: { members: { some: { userId } } } },
    select: { collectionId: true, collection: { select: { name: true } } },
    distinct: ["collectionId"],
  });
  const collectionIds = rows.map((r) => r.collectionId).sort();
  const collectionNames = rows.map((r) => r.collection.name).sort();
  const scope = { userId, collectionIds, key: collectionIds.join(","), collectionNames };
  scopeCache.set(userId, scope);
  return scope;
}

export function invalidateScopes() {
  scopeCache.clear();
}

/** Readable document for this user (IDOR guard): 404 rather than 403 to avoid existence leaks. */
export async function readableDocument(user: AuthUser, documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, include: { collection: true, currentVersion: true } });
  if (!doc) throw notFound();
  if (user.role === "ADMIN") return doc;
  const scope = await scopeFor(user.id);
  if (!scope.collectionIds.includes(doc.collectionId)) throw notFound();
  return doc;
}

export async function readableChunk(user: AuthUser, chunkId: string) {
  const chunk = await prisma.chunk.findUnique({ where: { id: chunkId }, include: { version: { include: { document: { include: { collection: true } } } } } });
  if (!chunk || chunk.version.document.deletedAt) throw notFound();
  if (user.role !== "ADMIN") {
    const scope = await scopeFor(user.id);
    if (!scope.collectionIds.includes(chunk.collectionId)) throw notFound();
  }
  return chunk;
}
