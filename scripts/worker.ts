// Standalone ingestion worker (set VOICERAG_INPROCESS_WORKER=false on web nodes).
// Any number of workers may run: jobs are claimed with FOR UPDATE SKIP LOCKED.
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const { startWorker } = await import("../src/server/rag/ingest");
  const stop = startWorker(1000);
  console.log("ingestion worker started");
  const exit = () => {
    stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGTERM", exit);
  process.on("SIGINT", exit);
}

void main();
