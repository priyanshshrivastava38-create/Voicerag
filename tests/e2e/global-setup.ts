// Seeds the TEST database with the synthetic corpus (mock embeddings) before the browser suite.
import fs from "node:fs";

export default async function globalSetup() {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  Object.assign(process.env, { DATABASE_URL: process.env.DATABASE_URL_TEST, EMBED_PROVIDER: "mock", VOICERAG_STORAGE_DIR: "./storage/test" });
  const { seeded } = await import("../integration/helpers");
  await seeded();
  const { prisma } = await import("../../src/lib/db");
  await prisma.$disconnect();
}
