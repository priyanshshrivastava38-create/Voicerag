// Background ingestion. DocumentVersion rows are the job queue:
//   claim (FOR UPDATE SKIP LOCKED) → extract → chunk → embed (content-hash cache) →
//   one transaction: replace this version's chunks, activate them, deactivate older versions,
//   point the document at this version, bump the index version.
// Retries are idempotent: chunks are keyed (versionId, ordinal) and replaced wholesale, and the
// embedding cache means a retry never pays for embeddings twice.
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";
import { redactString } from "@/lib/redact";
import { providers } from "../providers/registry";
import { chunkBlocks, embeddingText } from "./chunk";
import { extract } from "./extract";
import { bumpIndexVersion } from "./index-state";
import { clearRetrievalCache } from "./retrieve";
import { kindFromFilename } from "./validate";
import { vectorLiteral } from "./vector";
import { neutralizeInjections } from "./prompt";
import { auditAsync } from "../audit";
import { readStoredFile } from "../storage";

const MAX_ATTEMPTS = 3;
const STALE_LOCK_MINUTES = 10;
const EMBED_BATCH = 16;

/** Atomically claim the oldest queued (or stale) version. Safe with any number of workers. */
export async function claimNext(): Promise<{ id: string } | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "DocumentVersion" SET status = 'PROCESSING', "lockedAt" = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "DocumentVersion"
      WHERE (status = 'QUEUED')
         OR (status = 'PROCESSING' AND "lockedAt" < now() - make_interval(mins => ${STALE_LOCK_MINUTES}::int))
      ORDER BY "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  return rows[0] ?? null;
}

export async function processVersion(versionId: string): Promise<void> {
  const v = await prisma.documentVersion.findUnique({ where: { id: versionId }, include: { document: true } });
  if (!v) return;
  const embed = providers().embed;
  try {
    if (v.document.deletedAt) throw new Error("Document was deleted before indexing.");
    const kind = kindFromFilename(v.document.filename);
    if (!kind) throw new Error("Unsupported file type.");
    const buf = await readStoredFile(v.storagePath);
    if (sha256(buf) !== v.contentHash) throw new Error("Stored file failed its integrity check.");
    const extracted = await extract(kind, buf);
    const drafts = chunkBlocks(extracted.blocks, env.chunkTargetWords, env.chunkOverlapWords);
    if (!drafts.length) throw new Error("No text chunks produced.");

    // Embeddings: reuse cached vectors for unchanged chunk text + model.
    const keyed = drafts.map((d) => ({ d, key: sha256(embeddingText(v.document.title, d)) }));
    const keys = [...new Set(keyed.map((k) => k.key))];
    const cached = new Map<string, string>();
    for (let i = 0; i < keys.length; i += 500) {
      const rows = await prisma.$queryRaw<{ contentHash: string; v: string }[]>`
        SELECT "contentHash", embedding::text AS v FROM "EmbeddingCache"
        WHERE model = ${embed.model} AND "contentHash" = ANY(${keys.slice(i, i + 500)}::text[])`;
      for (const r of rows) cached.set(r.contentHash, r.v);
    }
    const missing = keyed.filter((k) => !cached.has(k.key));
    const uniqueMissing = [...new Map(missing.map((m) => [m.key, m])).values()];
    for (let i = 0; i < uniqueMissing.length; i += EMBED_BATCH) {
      const batch = uniqueMissing.slice(i, i + EMBED_BATCH);
      const vecs = await embed.embed(batch.map((b) => embeddingText(v.document.title, b.d)), "document");
      for (let j = 0; j < batch.length; j++) {
        const lit = vectorLiteral(vecs[j]);
        cached.set(batch[j].key, lit);
        await prisma.$executeRaw`
          INSERT INTO "EmbeddingCache" ("contentHash", model, embedding) VALUES (${batch[j].key}, ${embed.model}, ${lit}::vector)
          ON CONFLICT DO NOTHING`;
      }
    }

    await prisma.$transaction(
      async (tx) => {
        // Re-check under lock: a concurrent delete or a newer version must win.
        const doc = await tx.$queryRaw<{ deletedAt: Date | null }[]>`SELECT "deletedAt" FROM "Document" WHERE id = ${v.documentId} FOR UPDATE`;
        if (!doc[0] || doc[0].deletedAt) throw new Error("Document was deleted during indexing.");
        await tx.chunk.deleteMany({ where: { versionId: v.id } });
        for (const { d, key } of keyed) {
          await tx.$executeRaw`
            INSERT INTO "Chunk" (id, "versionId", "documentId", "collectionId", ordinal, text, "headingPath", "pageStart", "pageEnd", "contentHash", active, embedding)
            VALUES (${`ch_${v.id}_${d.ordinal}`}, ${v.id}, ${v.documentId}, ${v.document.collectionId}, ${d.ordinal}, ${d.text}, ${d.headingPath}, ${d.pageStart}, ${d.pageEnd}, ${d.contentHash}, false, ${cached.get(key)!}::vector)`;
        }
        const newer = await tx.documentVersion.findFirst({ where: { documentId: v.documentId, version: { gt: v.version }, status: "READY" } });
        if (!newer) {
          await tx.chunk.updateMany({ where: { documentId: v.documentId, versionId: { not: v.id } }, data: { active: false } });
          await tx.chunk.updateMany({ where: { versionId: v.id }, data: { active: true } });
          await tx.document.update({ where: { id: v.documentId }, data: { currentVersionId: v.id } });
        }
        await tx.documentVersion.update({
          where: { id: v.id },
          data: { status: "READY", error: null, chunkCount: drafts.length, pageCount: extracted.pageCount, embeddingModel: embed.model, indexedAt: new Date(), lockedAt: null },
        });
        await bumpIndexVersion(tx);
      },
      { timeout: 60_000 },
    );
    clearRetrievalCache();
    const suspicious = drafts.filter((d) => neutralizeInjections(d.text).removed > 0).length;
    if (suspicious) auditAsync({ action: "document.injection_suspected", targetType: "DocumentVersion", targetId: v.id, details: { chunks: suspicious } });
  } catch (e) {
    const msg = redactString(e instanceof Error ? e.message : String(e)).slice(0, 500);
    const fresh = await prisma.documentVersion.findUnique({ where: { id: versionId }, select: { attempts: true } });
    const retryable = !/deleted|Unsupported|integrity|No extractable|exceeds|No text/.test(msg) && (fresh?.attempts ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;
    await prisma.documentVersion.update({ where: { id: versionId }, data: { status: retryable ? "QUEUED" : "FAILED", error: msg, lockedAt: null } });
    if (!retryable) console.error(`[ingest] version ${versionId} failed: ${msg}`);
  }
}

/** Process queued work until the queue is empty. Returns the number of versions processed. */
export async function drainQueue(max = 100, shouldStop: () => boolean = () => false): Promise<number> {
  let n = 0;
  while (n < max && !shouldStop()) {
    const job = await claimNext();
    if (!job) break;
    await processVersion(job.id);
    n++;
  }
  return n;
}

/**
 * Long-running poll loop (in-process or `npm run worker`). The returned stop function resolves once
 * the job in progress (if any) has finished, so a shutdown never leaves a version stuck in PROCESSING.
 */
export function startWorker(intervalMs = 1500): () => Promise<void> {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await drainQueue(100, () => stopped);
    } catch (e) {
      console.error("[ingest] worker error:", redactString(String(e)));
    } finally {
      running = false;
    }
  };
  const id = setInterval(tick, intervalMs);
  void tick();
  return async () => {
    stopped = true;
    clearInterval(id);
    while (running) await new Promise((r) => setTimeout(r, 50));
  };
}
