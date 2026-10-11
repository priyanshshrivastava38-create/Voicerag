// Uploaded-file storage. "fs" (default): content-addressed files under VOICERAG_STORAGE_DIR, outside
// the web root, never served statically. "db": bytes in Postgres (DocumentBlob), for hosts with no
// shared disk between the web UI and the ingestion worker (docs/DEPLOY-VERCEL.md).
// The storage path records where each file went, so switching backends never orphans old uploads.
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

const DB_PREFIX = "db:";

export async function storeFile(buf: Buffer, hash: string, filename: string): Promise<string> {
  if (env.storageBackend === "db") {
    await prisma.documentBlob.upsert({ where: { contentHash: hash }, create: { contentHash: hash, data: new Uint8Array(buf) }, update: {} });
    return `${DB_PREFIX}${hash}`;
  }
  const dir = path.join(env.storageDir, "documents", hash.slice(0, 2));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `${hash}${path.extname(filename).toLowerCase()}`);
  await fs.writeFile(p, buf, { mode: 0o600 });
  return p;
}

export async function readStoredFile(storagePath: string): Promise<Buffer> {
  if (!storagePath.startsWith(DB_PREFIX)) return fs.readFile(storagePath);
  const blob = await prisma.documentBlob.findUnique({ where: { contentHash: storagePath.slice(DB_PREFIX.length) } });
  if (!blob) throw new Error("Stored file is missing.");
  return Buffer.from(blob.data);
}

export async function removeStoredFile(storagePath: string): Promise<void> {
  if (!storagePath.startsWith(DB_PREFIX)) return fs.rm(storagePath, { force: true });
  await prisma.documentBlob.deleteMany({ where: { contentHash: storagePath.slice(DB_PREFIX.length) } });
}
