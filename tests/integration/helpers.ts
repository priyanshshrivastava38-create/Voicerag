import fs from "node:fs";
import { prisma } from "@/lib/db";
import type { AuthUser } from "@/lib/auth";
import { invalidateScopes } from "@/server/access";
import { forgetIndexVersion } from "@/server/rag/index-state";
import { resetCaches } from "@/server/rag/retrieve";
import { setProviders } from "@/server/providers/registry";
import { writeSeedDocs } from "../../scripts/make-seed-docs";
import { seed } from "../../prisma/seed";

export const TEST_PASSWORD = "test-password-123";

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  await prisma.indexState.create({ data: { id: 1, version: 1 } });
  resetCaches();
  invalidateScopes();
  forgetIndexVersion();
  setProviders(null);
}

export async function seeded() {
  await resetDb();
  if (!fs.existsSync("seed/docs/leave-policy.pdf")) await writeSeedDocs(false);
  const r = await seed({ password: TEST_PASSWORD, log: false });
  const u = (email: string): AuthUser => r.users.get(email)!;
  return { ...r, admin: u("admin@vih.test"), alice: u("alice@vih.test"), bob: u("bob@vih.test"), carol: u("carol@vih.test") };
}
