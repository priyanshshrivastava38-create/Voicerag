import { describe, expect, it } from "vitest";
import { chunkBlocks } from "@/server/rag/chunk";
import { extractMarkdown, looksLikeHeading } from "@/server/rag/extract";
import { applyPolicy, keywordCoverage, normalizeQuery, queryTerms, type Evidence } from "@/server/rag/retrieve";
import { expandQuery } from "@/server/rag/glossary";
import { sanitizeFilename, validateUpload } from "@/server/rag/validate";

describe("extraction and chunking", () => {
  it("keeps markdown heading paths and never crosses sections", () => {
    const e = extractMarkdown("# Policy\n\n## Leave\n\nYou get 22 days. Ask HR.\n\n## Sick\n\nTwelve days.", true);
    expect(e.title).toBe("Policy");
    const c = chunkBlocks(e.blocks, 50, 10);
    expect(c.map((x) => x.headingPath)).toEqual(["Policy > Leave", "Policy > Sick"]);
    expect(new Set(c.map((x) => x.contentHash)).size).toBe(2);
  });
  it("packs to the target size with sentence overlap", () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} has exactly seven words.`).join(" ");
    const c = chunkBlocks([{ text: sentences, headings: ["S"], page: 3 }], 30, 8);
    expect(c.length).toBeGreaterThan(3);
    for (const x of c) expect(x.text.split(" ").length).toBeLessThanOrEqual(30);
    expect(c[1].text.startsWith(c[0].text.split(". ").pop()!.split(" ")[0])).toBe(true);
    expect(c.every((x) => x.pageStart === 3)).toBe(true);
  });
  it("recognises PDF-style headings", () => {
    expect(looksLikeHeading("2. Annual Leave")).toBe(true);
    expect(looksLikeHeading("Parental Leave")).toBe(true);
    expect(looksLikeHeading("Employees receive 22 days of leave.")).toBe(false);
  });
});

describe("upload validation", () => {
  it("checks extension, magic bytes, encoding and size", () => {
    expect(validateUpload("a.pdf", Buffer.from("%PDF-1.7 ..."), 1000)).toBe("pdf");
    expect(() => validateUpload("a.pdf", Buffer.from("not a pdf"), 1000)).toThrow(/not a PDF/);
    expect(() => validateUpload("a.exe", Buffer.from("MZ"), 1000)).toThrow(/Unsupported/);
    expect(() => validateUpload("a.txt", Buffer.from([0xff, 0xfe, 0x00]), 1000)).toThrow();
    expect(() => validateUpload("a.md", Buffer.alloc(2000, 65), 1000)).toThrow(/limit/);
    expect(() => validateUpload("a.docx", Buffer.from("PK\x03\x04nothing"), 1000)).toThrow(/Word/);
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  });
});

describe("retrieval policy", () => {
  const e = (documentId: string, sim: number, cov = 0): Evidence => ({ chunkId: `${documentId}-${sim}`, documentId, collectionId: "c", collection: "C", title: documentId, text: "t", headingPath: null, pageStart: null, pageEnd: null, sim, keywordCoverage: cov, fused: sim });
  const th = { minSim: 0.73, minSimKw: 0.66, minSimBorderline: 0 };
  it("abstains when nothing is strong enough", () => {
    expect(applyPolicy([e("a", 0.6, 0.2), e("b", 0.7, 0.4)], 4, th)).toMatchObject({ abstain: true, reason: "low_relevance" });
    expect(applyPolicy([], 4, th)).toMatchObject({ abstain: true, reason: "no_candidates" });
  });
  it("accepts a moderate match with strong keyword coverage", () => {
    expect(applyPolicy([e("a", 0.68, 0.6)], 4, th).abstain).toBe(false);
  });
  it("passes borderline matches to the LLM, best first, and still abstains below the floor", () => {
    const b = { ...th, minSimBorderline: 0.6 };
    const r = applyPolicy([e("a", 0.55), e("b", 0.64), e("c", 0.62)], 4, b);
    expect(r).toMatchObject({ abstain: false, reason: "borderline" });
    expect(r.evidence.map((x) => x.documentId)).toEqual(["b", "c"]);
    expect(applyPolicy([e("a", 0.55, 0.2)], 4, b)).toMatchObject({ abstain: true, reason: "low_relevance" });
  });
  it("expands workplace shorthand without losing the original wording", () => {
    expect(expandQuery("who signs off on my PR")).toBe("who signs off on my PR (pull request code review)");
    expect(expandQuery("deploy to prod during a sev one")).toContain("production");
    expect(expandQuery("deploy to prod during a sev one")).toContain("SEV1");
    expect(expandQuery(expandQuery("my PR"))).toBe(expandQuery("my PR"));
    expect(expandQuery("annual leave")).toBe("annual leave");
    expect(expandQuery("express train")).toBe("express train"); // no false match inside words
  });
  it("caps evidence per document and drops weak candidates", () => {
    const r = applyPolicy([e("a", 0.9), e("a", 0.85), e("a", 0.84), e("b", 0.8), e("c", 0.3)], 4, th);
    expect(r.evidence.map((x) => x.documentId)).toEqual(["a", "a", "b"]);
  });
  it("normalises queries and ignores stop/domain words for coverage", () => {
    expect(normalizeQuery("  How MANY days?! ")).toBe("how many days");
    expect(queryTerms("Who is the CEO of VIH Metaverse?")).toEqual(["ceo"]);
    expect(keywordCoverage(["annual", "leave"], "Annual leave is 22 days")).toBe(1);
  });
});
