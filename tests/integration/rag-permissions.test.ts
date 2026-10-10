import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { readableChunk, readableDocument, scopeFor } from "@/server/access";
import { retrieve } from "@/server/rag/retrieve";
import { DOCS } from "../../seed/content";
import { seeded } from "./helpers";

let s: Awaited<ReturnType<typeof seeded>>;
beforeAll(async () => {
  s = await seeded();
});

const finance = async () => (await prisma.collection.findUniqueOrThrow({ where: { slug: "finance" } })).id;

describe("seeded knowledge base", () => {
  it("indexes every synthetic document exactly once", async () => {
    const versions = await prisma.documentVersion.findMany();
    expect(versions).toHaveLength(DOCS.length);
    expect(versions.every((v) => v.status === "READY" && v.chunkCount > 0)).toBe(true);
    const active = await prisma.chunk.count({ where: { active: true } });
    expect(active).toBe(versions.reduce((a, v) => a + v.chunkCount, 0));
  });
});

describe("permission-aware retrieval", () => {
  it("retrieves restricted finance content only for users granted it", async () => {
    const fin = await finance();
    const bob = await retrieve(await scopeFor(s.bob.id), "What is the FY27 research and development budget?");
    expect(bob.evidence.some((e) => e.collectionId === fin)).toBe(true);
    const alice = await retrieve(await scopeFor(s.alice.id), "What is the FY27 research and development budget?");
    expect(alice.evidence.some((e) => e.collectionId === fin)).toBe(false);
  });

  it("never serves one scope's cached results to another scope", async () => {
    const q = "Hotel cap per night in metro cities";
    const fin = await finance();
    const b1 = await retrieve(await scopeFor(s.bob.id), q);
    expect(b1.evidence.some((e) => e.collectionId === fin)).toBe(true);
    const a1 = await retrieve(await scopeFor(s.alice.id), q);
    expect(a1.cacheHit).toBe(false);
    expect(a1.evidence.some((e) => e.collectionId === fin)).toBe(false);
    const a2 = await retrieve(await scopeFor(s.alice.id), q);
    expect(a2.cacheHit).toBe(true);
    expect(a2.evidence.some((e) => e.collectionId === fin)).toBe(false);
  });

  it("returns no evidence for users without any grants", async () => {
    const r = await retrieve(await scopeFor(s.carol.id), "How many days of annual leave do I get?");
    expect(r).toMatchObject({ abstain: true, reason: "no_authorized_collections", evidence: [] });
  });

  it("guards direct object access to chunks and documents (404, not 403)", async () => {
    const fin = await finance();
    const chunk = await prisma.chunk.findFirstOrThrow({ where: { collectionId: fin } });
    await expect(readableChunk(s.alice, chunk.id)).rejects.toMatchObject({ status: 404 });
    await expect(readableChunk(s.bob, chunk.id)).resolves.toMatchObject({ id: chunk.id });
    await expect(readableChunk(s.admin, chunk.id)).resolves.toMatchObject({ id: chunk.id });
    await expect(readableDocument(s.carol, chunk.documentId)).rejects.toBeInstanceOf(ApiError);
  });
});
