// Retention: delete conversations (messages, citations, feedback cascade), turn metrics, expired
// sessions and audit events older than VOICERAG_RETENTION_DAYS. Run daily (cron / scheduler).
//   npm run retention:purge [-- --dry-run]
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const dry = process.argv.includes("--dry-run");
  const { prisma } = await import("../src/lib/db");
  const { env } = await import("../src/lib/env");
  const cutoff = new Date(Date.now() - env.retentionDays * 86400_000);
  const auditCutoff = new Date(Date.now() - Math.max(env.retentionDays, 365) * 86400_000); // audit kept ≥ 1 year
  const counts = {
    conversations: await prisma.conversation.count({ where: { updatedAt: { lt: cutoff } } }),
    turnMetrics: await prisma.turnMetric.count({ where: { createdAt: { lt: cutoff } } }),
    sessions: await prisma.session.count({ where: { expiresAt: { lt: new Date() } } }),
    auditEvents: await prisma.auditEvent.count({ where: { createdAt: { lt: auditCutoff } } }),
  };
  if (!dry) {
    await prisma.conversation.deleteMany({ where: { updatedAt: { lt: cutoff } } });
    await prisma.turnMetric.deleteMany({ where: { createdAt: { lt: cutoff } } });
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await prisma.auditEvent.deleteMany({ where: { createdAt: { lt: auditCutoff } } });
    await prisma.auditEvent.create({ data: { action: "retention.purged", details: { ...counts, retentionDays: env.retentionDays } } });
  }
  console.log(`${dry ? "[dry run] would delete" : "deleted"}: ${JSON.stringify(counts)} (retention ${env.retentionDays} days)`);
  await prisma.$disconnect();
}

void main();
