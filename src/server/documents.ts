// Knowledge management: collections, uploads, re-indexing, deletion. Admin-only mutations;
// members can list documents in collections granted to them (for source viewing).
import { prisma } from "@/lib/db";
import type { AuthUser } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth";
import { sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { scopeFor } from "./access";
import { audit } from "./audit";
import { bumpIndexVersion } from "./rag/index-state";
import { clearRetrievalCache } from "./rag/retrieve";
import { MIME, sanitizeFilename, validateUpload } from "./rag/validate";
import { removeStoredFile, storeFile } from "./storage";

export async function listCollections(user: AuthUser) {
  const scope = await scopeFor(user.id);
  const where = user.role === "ADMIN" ? {} : { id: { in: scope.collectionIds } };
  const cols = await prisma.collection.findMany({
    where,
    orderBy: { name: "asc" },
    include: { grants: { include: { group: { select: { name: true } } } }, _count: { select: { documents: { where: { deletedAt: null } } } } },
  });
  return cols.map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    department: c.department,
    description: c.description,
    documents: c._count.documents,
    searchable: scope.collectionIds.includes(c.id),
    groups: user.role === "ADMIN" ? c.grants.map((g) => g.group.name) : undefined,
  }));
}

export async function listDocuments(user: AuthUser, collectionId?: string) {
  const scope = await scopeFor(user.id);
  const allowed = user.role === "ADMIN" ? undefined : scope.collectionIds;
  if (collectionId && allowed && !allowed.includes(collectionId)) throw notFound();
  const docs = await prisma.document.findMany({
    where: { deletedAt: null, ...(collectionId ? { collectionId } : allowed ? { collectionId: { in: allowed } } : {}) },
    orderBy: { updatedAt: "desc" },
    include: { collection: { select: { name: true } }, versions: { orderBy: { version: "desc" }, take: 1 }, currentVersion: true },
    take: 500,
  });
  return docs.map((d) => {
    const latest = d.versions[0];
    return {
      id: d.id,
      title: d.title,
      filename: d.filename,
      collectionId: d.collectionId,
      collection: d.collection.name,
      updatedAt: d.updatedAt,
      status: latest?.status ?? "QUEUED",
      error: user.role === "ADMIN" ? latest?.error ?? null : null,
      version: latest?.version ?? 0,
      liveVersion: d.currentVersion?.version ?? null,
      chunks: d.currentVersion?.chunkCount ?? 0,
      pages: d.currentVersion?.pageCount ?? null,
    };
  });
}

/**
 * Create a document, or a new version when `documentId` is given. Idempotent: uploading the same
 * bytes again for the same document returns the existing version instead of re-indexing.
 */
export async function uploadDocument(user: AuthUser, input: { collectionId: string; filename: string; title?: string; data: Buffer; documentId?: string }) {
  requireAdmin(user);
  const filename = sanitizeFilename(input.filename);
  const kind = validateUpload(filename, input.data, env.maxUploadBytes);
  const collection = await prisma.collection.findUnique({ where: { id: input.collectionId } });
  if (!collection) throw badRequest("Unknown collection.");
  const hash = sha256(input.data);
  const title = (input.title?.trim() || filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")).slice(0, 200);

  if (input.documentId) {
    const doc = await prisma.document.findFirst({ where: { id: input.documentId, deletedAt: null } });
    if (!doc) throw notFound();
    if (doc.collectionId !== input.collectionId) throw badRequest("A new version must stay in the same collection.");
    const existing = await prisma.documentVersion.findUnique({ where: { documentId_contentHash: { documentId: doc.id, contentHash: hash } } });
    if (existing) return { documentId: doc.id, versionId: existing.id, duplicate: true };
    const storagePath = await storeFile(input.data, hash, filename);
    const v = await prisma.$transaction(async (tx) => {
      const last = await tx.documentVersion.aggregate({ where: { documentId: doc.id }, _max: { version: true } });
      await tx.document.update({ where: { id: doc.id }, data: { filename, mimeType: MIME[kind] } });
      return tx.documentVersion.create({ data: { documentId: doc.id, version: (last._max.version ?? 0) + 1, contentHash: hash, sizeBytes: input.data.length, storagePath } });
    });
    await audit({ actorId: user.id, action: "document.version_uploaded", targetType: "Document", targetId: doc.id, details: { version: v.version, bytes: input.data.length } });
    return { documentId: doc.id, versionId: v.id, duplicate: false };
  }

  // Same bytes already live in this collection → do not create a duplicate document.
  const dup = await prisma.documentVersion.findFirst({ where: { contentHash: hash, document: { collectionId: collection.id, deletedAt: null } }, select: { id: true, documentId: true } });
  if (dup) return { documentId: dup.documentId, versionId: dup.id, duplicate: true };
  const storagePath = await storeFile(input.data, hash, filename);
  const doc = await prisma.document.create({
    data: { collectionId: collection.id, title, filename, mimeType: MIME[kind], createdById: user.id, versions: { create: { version: 1, contentHash: hash, sizeBytes: input.data.length, storagePath } } },
    include: { versions: true },
  });
  await audit({ actorId: user.id, action: "document.uploaded", targetType: "Document", targetId: doc.id, details: { collection: collection.slug, bytes: input.data.length, kind } });
  return { documentId: doc.id, versionId: doc.versions[0].id, duplicate: false };
}

export async function reindexDocument(user: AuthUser, documentId: string) {
  requireAdmin(user);
  const doc = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!doc || !doc.versions[0]) throw notFound();
  const v = doc.versions[0];
  if (v.status === "QUEUED" || v.status === "PROCESSING") throw conflict("Indexing is already in progress.");
  await prisma.documentVersion.update({ where: { id: v.id }, data: { status: "QUEUED", attempts: 0, error: null } });
  await audit({ actorId: user.id, action: "document.reindex_requested", targetType: "Document", targetId: doc.id });
  return { documentId: doc.id, versionId: v.id };
}

/**
 * Delete: chunks are removed from the index immediately (same transaction as the index-version
 * bump, so no cache can serve them afterwards), stored files are erased, and citation excerpts
 * that quoted the document are scrubbed. The Document row remains (deletedAt) for the audit trail.
 */
export async function deleteDocument(user: AuthUser, documentId: string) {
  requireAdmin(user);
  const doc = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, include: { versions: true } });
  if (!doc) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${doc.id} FOR UPDATE`;
    await tx.chunk.deleteMany({ where: { documentId: doc.id } });
    await tx.document.update({ where: { id: doc.id }, data: { deletedAt: new Date(), currentVersionId: null } });
    await tx.documentVersion.updateMany({ where: { documentId: doc.id, status: { in: ["QUEUED", "PROCESSING"] } }, data: { status: "FAILED", error: "Document deleted." } });
    await tx.citation.updateMany({ where: { documentId: doc.id }, data: { excerpt: "[source document deleted]" } });
    await bumpIndexVersion(tx);
  });
  clearRetrievalCache();
  for (const v of doc.versions) {
    const shared = await prisma.documentVersion.count({ where: { storagePath: v.storagePath, document: { deletedAt: null } } });
    if (!shared) await removeStoredFile(v.storagePath);
  }
  await audit({ actorId: user.id, action: "document.deleted", targetType: "Document", targetId: doc.id, details: { versions: doc.versions.length } });
  return { ok: true };
}
