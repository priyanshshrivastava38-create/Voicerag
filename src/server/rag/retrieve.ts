// Permission-aware hybrid retrieval.
//
//  1. Query embedding (cached per model + normalised text).
//  2. ONE SQL round trip: pgvector HNSW top-N ∪ full-text top-N, both restricted to the caller's
//     authorised, active collections inside the query (the filter is never applied afterwards).
//  3. Reciprocal-rank fusion, per-document diversity cap, top-k.
//  4. Explicit abstention policy on raw cosine similarity + keyword coverage. These scores are
//     NOT calibrated probabilities; thresholds are tuned on the labelled eval set.
//
// Results are cached by (index version, authorisation scope, k, normalised query) so a cached
// answer can never cross a permission boundary or survive a document update/delete.
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";
import { TtlLru } from "@/lib/lru";
import type { Scope } from "../access";
import { providers } from "../providers/registry";
import { expandQuery } from "./glossary";
import { indexVersion } from "./index-state";
import { vectorLiteral } from "./vector";

export interface Evidence {
  chunkId: string;
  documentId: string;
  collectionId: string;
  collection: string;
  title: string;
  text: string;
  headingPath: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  sim: number;
  keywordCoverage: number;
  fused: number;
}

export interface RetrievalResult {
  evidence: Evidence[];
  abstain: boolean;
  reason: string;
  topSim: number | null;
  timings: { embedMs: number; searchMs: number; totalMs: number };
  cacheHit: boolean;
  embedCacheHit: boolean;
}

const embedCache = new TtlLru<number[]>("query-embedding", 2000, 30 * 60_000);
let retrievalCache = new TtlLru<RetrievalResult>("retrieval", env.ragCacheMaxEntries, env.ragCacheTtlMs);

export function clearRetrievalCache() {
  retrievalCache.clear();
}
export function cacheStats() {
  return [embedCache.stats(), retrievalCache.stats()];
}
export function resetCaches() {
  embedCache.clear();
  retrievalCache = new TtlLru<RetrievalResult>("retrieval", env.ragCacheMaxEntries, env.ragCacheTtlMs);
}

export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(
  "a about an and any are as at be been but by can could did do does for from get got had has have how i if in into is it its me my of on or our please should so tell than that the their them there these they this those to us was we what when where which who whom why will with would you your".split(" "),
);
// Terms present across the whole corpus carry no evidence of relevance (every document is a
// "VIH Metaverse" "policy" for "employees"); they are ignored when measuring keyword coverage.
const DOMAIN_STOP = new Set((process.env.RAG_DOMAIN_STOPWORDS ?? "vih metaverse company employee employees staff policy").toLowerCase().split(/[\s,]+/).filter(Boolean));
function stem(w: string) {
  return w.length > 4 ? w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "") : w;
}
export function queryTerms(q: string): string[] {
  return [...new Set((normalizeQuery(q).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w) && !DOMAIN_STOP.has(w) && w.length > 1).map(stem))];
}
export function keywordCoverage(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const words = new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem));
  return terms.filter((t) => words.has(t)).length / terms.length;
}

export async function embedQuery(q: string, signal?: AbortSignal): Promise<{ vec: number[]; hit: boolean }> {
  const emb = providers().embed;
  q = expandQuery(q);
  const key = `${emb.model}|${normalizeQuery(q)}`;
  const hit = embedCache.get(key);
  if (hit) return { vec: hit, hit: true };
  const [vec] = await emb.embed([q], "query", signal);
  embedCache.set(key, vec);
  return { vec, hit: false };
}

interface Row {
  id: string;
  text: string;
  headingPath: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  documentId: string;
  collectionId: string;
  title: string;
  collection: string;
  sim: number;
  vr: bigint | null;
  kr: bigint | null;
}

export async function retrieve(scope: Scope, query: string, opts: { k?: number; signal?: AbortSignal; bypassCache?: boolean } = {}): Promise<RetrievalResult> {
  const t0 = performance.now();
  const k = opts.k ?? env.ragTopK;
  const norm = normalizeQuery(query);
  if (!norm || scope.collectionIds.length === 0) {
    return { evidence: [], abstain: true, reason: scope.collectionIds.length ? "empty_query" : "no_authorized_collections", topSim: null, timings: { embedMs: 0, searchMs: 0, totalMs: 0 }, cacheHit: false, embedCacheHit: false };
  }

  const [iv, emb] = await Promise.all([indexVersion(), (async () => {
    const t = performance.now();
    const r = await embedQuery(query, opts.signal);
    return { ...r, ms: performance.now() - t };
  })()]);
  const cacheKey = sha256(`${iv}|${scope.key}|${k}|${norm}`);
  if (!opts.bypassCache) {
    const hit = retrievalCache.get(cacheKey);
    if (hit) return { ...hit, cacheHit: true, embedCacheHit: emb.hit, timings: { embedMs: Math.round(emb.ms), searchMs: 0, totalMs: Math.round(performance.now() - t0) } };
  }
  opts.signal?.throwIfAborted();

  const { ranked, searchMs } = await searchCandidates(scope, query, emb.vec);
  const result = applyPolicy(ranked, k);
  const out: RetrievalResult = { ...result, timings: { embedMs: Math.round(emb.ms), searchMs: Math.round(searchMs), totalMs: Math.round(performance.now() - t0) }, cacheHit: false, embedCacheHit: emb.hit };
  retrievalCache.set(cacheKey, out);
  return out;
}

/** Hybrid candidate search inside the caller's scope, ranked by reciprocal-rank fusion. */
export async function searchCandidates(scope: Scope, query: string, queryVec: number[]): Promise<{ ranked: Evidence[]; searchMs: number }> {
  if (scope.collectionIds.length === 0) return { ranked: [], searchMs: 0 };
  query = expandQuery(query);
  const norm = normalizeQuery(query);
  const n = env.ragCandidates;
  const vec = vectorLiteral(queryVec);
  const ts = performance.now();
  const rows = await prisma.$queryRaw<Row[]>`
    WITH q AS (
      SELECT ${vec}::vector AS v,
             NULLIF(replace(plainto_tsquery('english', ${norm})::text, '&', '|'), '')::tsquery AS t
    ),
    vec AS (
      SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> q.v) AS r
      FROM "Chunk" c, q
      WHERE c.active AND c."collectionId" = ANY(${scope.collectionIds}::text[])
      ORDER BY c.embedding <=> q.v
      LIMIT ${n}
    ),
    kw AS (
      SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q.t) DESC) AS r
      FROM "Chunk" c, q
      WHERE q.t IS NOT NULL AND c.active AND c."collectionId" = ANY(${scope.collectionIds}::text[]) AND c.tsv @@ q.t
      ORDER BY ts_rank_cd(c.tsv, q.t) DESC
      LIMIT ${n}
    )
    SELECT c.id, c.text, c."headingPath", c."pageStart", c."pageEnd", c."documentId", c."collectionId",
           d.title, col.name AS collection,
           (1 - (c.embedding <=> q.v))::float8 AS sim, vec.r AS vr, kw.r AS kr
    FROM (SELECT id FROM vec UNION SELECT id FROM kw) u
    JOIN "Chunk" c ON c.id = u.id
    JOIN "Document" d ON d.id = c."documentId" AND d."deletedAt" IS NULL
    JOIN "Collection" col ON col.id = c."collectionId"
    CROSS JOIN q
    LEFT JOIN vec ON vec.id = c.id
    LEFT JOIN kw ON kw.id = c.id`;
  const searchMs = performance.now() - ts;

  const terms = queryTerms(query);
  const scored: Evidence[] = rows.map((r) => ({
    chunkId: r.id,
    documentId: r.documentId,
    collectionId: r.collectionId,
    collection: r.collection,
    title: r.title,
    text: r.text,
    headingPath: r.headingPath,
    pageStart: r.pageStart,
    pageEnd: r.pageEnd,
    sim: Number(r.sim),
    keywordCoverage: keywordCoverage(terms, `${r.title} ${r.headingPath ?? ""} ${r.text}`),
    fused: (r.vr ? 1 / (60 + Number(r.vr)) : 0) + (r.kr ? 1 / (60 + Number(r.kr)) : 0),
  }));
  // Defence in depth: the SQL already filters by scope; never let anything else through.
  const allowed = new Set(scope.collectionIds);
  const ranked = scored.filter((e) => allowed.has(e.collectionId)).sort((a, b) => b.fused - a.fused || b.sim - a.sim);
  return { ranked, searchMs };
}

/** Evidence selection + abstention. Exported for unit tests and threshold tuning. */
export function applyPolicy(
  ranked: Evidence[],
  k: number,
  th = { minSim: env.ragMinVectorSim, minSimKw: env.ragMinVectorSimWithKeyword, minSimBorderline: env.ragMinVectorSimBorderline },
) {
  const strong = (e: Evidence) => e.sim >= th.minSim || (e.sim >= th.minSimKw && e.keywordCoverage >= 0.5);
  const topSim = ranked.length ? Math.max(...ranked.map((e) => e.sim)) : null;
  if (!ranked.some(strong)) {
    // Borderline: a plausible match that is not clearly strong. Casually phrased questions land
    // here ("can I plug a pen drive in" vs "USB mass-storage devices are blocked"), and so do some
    // unanswerable ones, so similarity alone cannot decide. The best passages go to the LLM, whose
    // grounded prompt answers only if they actually answer the question and abstains otherwise.
    const borderline = th.minSimBorderline > 0 ? ranked.filter((e) => e.sim >= th.minSimBorderline).sort((a, b) => b.sim - a.sim) : [];
    if (borderline.length) {
      const perDoc = new Map<string, number>();
      const evidence: Evidence[] = [];
      for (const e of borderline) {
        if (evidence.length >= k) break;
        const c = perDoc.get(e.documentId) ?? 0;
        if (c >= 2) continue;
        perDoc.set(e.documentId, c + 1);
        evidence.push(e);
      }
      return { evidence, abstain: false, reason: "borderline", topSim };
    }
    return { evidence: [] as Evidence[], abstain: true, reason: ranked.length ? "low_relevance" : "no_candidates", topSim };
  }
  // Keep plausibly relevant candidates only, max 2 per document, in fused order.
  const perDoc = new Map<string, number>();
  const evidence: Evidence[] = [];
  for (const e of ranked) {
    if (evidence.length >= k) break;
    if (!(strong(e) || e.sim >= th.minSimKw)) continue;
    const c = perDoc.get(e.documentId) ?? 0;
    if (c >= 2) continue;
    perDoc.set(e.documentId, c + 1);
    evidence.push(e);
  }
  return { evidence, abstain: false, reason: "ok", topSim };
}
