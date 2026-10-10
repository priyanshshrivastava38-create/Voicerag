// Seeds groups, collections, users and the SYNTHETIC documents, then indexes them with the
// configured embedding provider. Idempotent: re-running reuses users and skips identical files.
//   npm run seed:docs && npm run db:seed
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env") && !process.env.VITEST) process.loadEnvFile(".env");

export async function seed(opts: { password?: string; log?: boolean } = {}) {
  const { prisma } = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/crypto");
  const { uploadDocument } = await import("../src/server/documents");
  const { drainQueue } = await import("../src/server/rag/ingest");
  const { invalidateScopes } = await import("../src/server/access");
  const { COLLECTIONS, DOCS, USERS } = await import("../seed/content");
  const log = opts.log === false ? () => undefined : console.log;
  const password = opts.password ?? process.env.VOICERAG_SEED_PASSWORD ?? "change-me-dev-only";

  const groupNames = [...new Set(COLLECTIONS.flatMap((c) => c.groups).concat(USERS.flatMap((u) => u.groups)))];
  const groups = new Map<string, string>();
  for (const name of groupNames) groups.set(name, (await prisma.group.upsert({ where: { name }, update: {}, create: { name } })).id);

  const cols = new Map<string, string>();
  for (const c of COLLECTIONS) {
    const col = await prisma.collection.upsert({ where: { slug: c.slug }, update: { name: c.name, department: c.department, description: c.description }, create: { slug: c.slug, name: c.name, department: c.department, description: c.description } });
    cols.set(c.slug, col.id);
    for (const g of c.groups) await prisma.collectionGrant.upsert({ where: { collectionId_groupId: { collectionId: col.id, groupId: groups.get(g)! } }, update: {}, create: { collectionId: col.id, groupId: groups.get(g)! } });
  }

  const users = new Map<string, { id: string; email: string; name: string; role: "ADMIN" | "MEMBER" }>();
  for (const u of USERS) {
    const row = await prisma.user.upsert({ where: { email: u.email }, update: { name: u.name, role: u.role }, create: { email: u.email, name: u.name, role: u.role, passwordHash: hashPassword(password) } });
    users.set(u.email, { id: row.id, email: row.email, name: row.name, role: row.role });
    for (const g of u.groups) await prisma.groupMember.upsert({ where: { groupId_userId: { groupId: groups.get(g)!, userId: row.id } }, update: {}, create: { groupId: groups.get(g)!, userId: row.id } });
  }
  invalidateScopes();

  const admin = users.get("admin@vih.test")!;
  for (const d of DOCS) {
    const p = path.resolve("seed/docs", d.file);
    if (!fs.existsSync(p)) throw new Error(`Missing ${p}; run npm run seed:docs first.`);
    // Same file name in the same collection → upload as a new version, never a duplicate document
    // (regenerated PDFs/DOCX differ byte-for-byte because they embed timestamps).
    const existing = await prisma.document.findFirst({ where: { collectionId: cols.get(d.collection)!, filename: d.file, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
    const r = await uploadDocument(admin, { collectionId: cols.get(d.collection)!, filename: d.file, title: d.title, data: fs.readFileSync(p), documentId: existing?.id });
    log(`${r.duplicate ? "unchanged" : "queued   "} ${d.file}`);
  }
  const t0 = Date.now();
  const n = await drainQueue();
  const failed = await prisma.documentVersion.findMany({ where: { status: "FAILED" }, select: { error: true, document: { select: { filename: true } } } });
  log(`indexed ${n} document version(s) in ${Date.now() - t0} ms${failed.length ? `; FAILED: ${failed.map((f) => `${f.document.filename}: ${f.error}`).join("; ")}` : ""}`);
  return { users, collections: cols, groups };
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed()
    .then(async () => {
      const { prisma } = await import("../src/lib/db");
      await prisma.$disconnect();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
