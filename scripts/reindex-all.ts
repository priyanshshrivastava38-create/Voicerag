// Re-queue and re-index every live document version (e.g. after changing chunking settings).
// Embeddings for unchanged chunk text are reused from the cache.   npx tsx scripts/reindex-all.ts
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const { prisma } = await import("../src/lib/db");
  const { drainQueue } = await import("../src/server/rag/ingest");
  const r = await prisma.documentVersion.updateMany({ where: { document: { deletedAt: null }, status: { in: ["READY", "FAILED"] } }, data: { status: "QUEUED", attempts: 0 } });
  const t0 = Date.now();
  const n = await drainQueue(10_000);
  console.log(`queued ${r.count}, indexed ${n} in ${Date.now() - t0} ms`);
  await prisma.$disconnect();
}

void main();
