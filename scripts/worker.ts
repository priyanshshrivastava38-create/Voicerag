// Standalone ingestion worker (set VOICERAG_INPROCESS_WORKER=false on web nodes).
// Any number of workers may run: jobs are claimed with FOR UPDATE SKIP LOCKED.
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const { startWorker } = await import("../src/server/rag/ingest");
  const { prisma } = await import("../src/lib/db");
  await prisma.$queryRaw`SELECT 1`; // fail fast with a clear error if the database is unreachable
  const stop = startWorker(1000);
  console.log("ingestion worker started");
  let stopping = false;
  const exit = async () => {
    if (stopping) return;
    stopping = true;
    console.log("ingestion worker: finishing the current job, then exiting");
    // Hard deadline: a hung job is reclaimed by another worker after the stale-lock timeout.
    setTimeout(() => process.exit(1), 60_000).unref();
    await stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void exit());
  process.on("SIGINT", () => void exit());
}

main().catch((e) => {
  console.error("ingestion worker failed to start:", e instanceof Error ? e.message : e);
  process.exit(1);
});
