import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { scopeFor } from "@/server/access";
import { deleteDocument, uploadDocument } from "@/server/documents";
import { providers } from "@/server/providers/registry";
import type { MockEmbed } from "@/server/providers/mock";
import { drainQueue } from "@/server/rag/ingest";
import { indexVersion } from "@/server/rag/index-state";
import { retrieve } from "@/server/rag/retrieve";
import { seeded } from "./helpers";

let s: Awaited<ReturnType<typeof seeded>>;
let general: string;
beforeAll(async () => {
  s = await seeded();
  general = (await prisma.collection.findUniqueOrThrow({ where: { slug: "general" } })).id;
});

const md = (title: string, body: string) => Buffer.from(`# ${title}\n\n## Details\n\n${body}\n`);

describe("ingestion", () => {
  it("does not create duplicates when the same file is uploaded again", async () => {
    const data = fs.readFileSync("seed/docs/employee-handbook.md");
    const before = await prisma.documentVersion.count();
    const r = await uploadDocument(s.admin, { collectionId: general, filename: "employee-handbook.md", data });
    expect(r.duplicate).toBe(true);
    expect(await prisma.documentVersion.count()).toBe(before);
  });

  it("processes each queued version once with concurrent workers", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await uploadDocument(s.admin, { collectionId: general, filename: `bulk-${i}.md`, data: md(`Bulk ${i}`, `Bulk document ${i} mentions the zebra crossing rule number ${i}.`) })).versionId);
    const processed = await Promise.all([drainQueue(), drainQueue(), drainQueue()]);
    expect(processed.reduce((a, b) => a + b, 0)).toBe(4);
    const vs = await prisma.documentVersion.findMany({ where: { id: { in: ids } } });
    expect(vs.every((v) => v.status === "READY" && v.attempts === 1)).toBe(true);
    for (const v of vs) expect(await prisma.chunk.count({ where: { versionId: v.id } })).toBe(v.chunkCount);
  });

  it("replaces a document's searchable content with a new version and invalidates caches", async () => {
    const first = await uploadDocument(s.admin, { collectionId: general, filename: "canteen.md", data: md("Canteen Rules", "The canteen sells mango lassi on Fridays only.") });
    await drainQueue();
    const scope = await scopeFor(s.alice.id);
    const q = "When does the canteen sell mango lassi?";
    const before = await retrieve(scope, q);
    expect(before.evidence[0]?.text).toContain("Fridays");
    const iv = await indexVersion();

    await uploadDocument(s.admin, { collectionId: general, filename: "canteen.md", documentId: first.documentId, data: md("Canteen Rules", "The canteen sells mango lassi on Mondays only.") });
    await drainQueue();
    expect(await indexVersion()).toBeGreaterThan(iv);
    const after = await retrieve(scope, q);
    expect(after.cacheHit).toBe(false);
    expect(after.evidence.map((e) => e.text).join(" ")).toContain("Mondays");
    expect(after.evidence.map((e) => e.text).join(" ")).not.toContain("Fridays");
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: first.documentId }, include: { currentVersion: true } });
    expect(doc.currentVersion?.version).toBe(2);
  });

  it("reuses cached embeddings when re-indexing unchanged content", async () => {
    const embed = providers().embed as MockEmbed;
    const doc = await prisma.document.findFirstOrThrow({ where: { filename: "it-security-policy.md" }, include: { versions: true } });
    await prisma.documentVersion.update({ where: { id: doc.versions[0].id }, data: { status: "QUEUED", attempts: 0 } });
    const calls = embed.calls;
    await drainQueue();
    expect(embed.calls).toBe(calls); // no embedding requests for unchanged chunks
    expect((await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.versions[0].id } })).status).toBe("READY");
  });

  it("removes deleted documents from retrieval immediately and scrubs stored data", async () => {
    const r = await uploadDocument(s.admin, { collectionId: general, filename: "bikes.md", data: md("Bike Storage", "Bicycles may be parked in basement bay seven.") });
    await drainQueue();
    const scope = await scopeFor(s.alice.id);
    const q = "Where can bicycles be parked?";
    expect((await retrieve(scope, q)).evidence.some((e) => e.documentId === r.documentId)).toBe(true);
    const path = (await prisma.documentVersion.findFirstOrThrow({ where: { documentId: r.documentId } })).storagePath;
    await deleteDocument(s.admin, r.documentId);
    expect(await prisma.chunk.count({ where: { documentId: r.documentId } })).toBe(0);
    expect((await retrieve(scope, q)).evidence.some((e) => e.documentId === r.documentId)).toBe(false);
    expect(fs.existsSync(path)).toBe(false);
  });

  it("stores uploads in Postgres with VOICERAG_STORAGE_BACKEND=db (split hosting) and erases them on delete", async () => {
    process.env.VOICERAG_STORAGE_BACKEND = "db";
    try {
      const r = await uploadDocument(s.admin, { collectionId: general, filename: "lockers.md", data: md("Lockers", "Day lockers are on the third floor next to the showers.") });
      const v = await prisma.documentVersion.findUniqueOrThrow({ where: { id: r.versionId } });
      expect(v.storagePath).toBe(`db:${v.contentHash}`);
      await drainQueue();
      expect((await prisma.documentVersion.findUniqueOrThrow({ where: { id: r.versionId } })).status).toBe("READY");
      const scope = await scopeFor(s.alice.id);
      expect((await retrieve(scope, "Where are the day lockers?")).evidence.some((e) => e.documentId === r.documentId)).toBe(true);
      await deleteDocument(s.admin, r.documentId);
      expect(await prisma.documentBlob.count({ where: { contentHash: v.contentHash } })).toBe(0);
    } finally {
      delete process.env.VOICERAG_STORAGE_BACKEND;
    }
  });

  it("marks unparseable documents FAILED after bounded retries", async () => {
    const r = await uploadDocument(s.admin, { collectionId: general, filename: "broken.pdf", data: Buffer.from("%PDF-1.7 this is not really a pdf") });
    await drainQueue();
    const v = await prisma.documentVersion.findUniqueOrThrow({ where: { id: r.versionId } });
    expect(v.status).toBe("FAILED");
    expect(v.attempts).toBeLessThanOrEqual(3);
    expect(v.error).toBeTruthy();
  });

  it("rejects uploads from non-admins", async () => {
    await expect(uploadDocument(s.alice, { collectionId: general, filename: "x.md", data: md("X", "y") })).rejects.toMatchObject({ status: 403 });
  });
});
