// RAG quality evaluation over the labelled synthetic set (seed/eval-set.ts).
//
//   npm run eval:rag                 retrieval metrics + abstention threshold sweep (no LLM)
//   npm run eval:rag -- --generate   also runs the configured LLM end-to-end (answers, citations,
//                                    groundedness, abstention, prompt injection)
//
// Writes bench-results/eval-rag-<timestamp>.json. Requires a seeded database (npm run db:seed).
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

async function main() {
  const generate = process.argv.includes("--generate");
  const { prisma } = await import("../src/lib/db");
  const { env } = await import("../src/lib/env");
  const { scopeFor } = await import("../src/server/access");
  const { applyPolicy, embedQuery, searchCandidates, retrieve, resetCaches } = await import("../src/server/rag/retrieve");
  const { providers, describeProviders } = await import("../src/server/providers/registry");
  const { runTurn } = await import("../src/server/voice/turn");
  const { TurnClock } = await import("../src/server/voice/clock");
  const { supportedSentenceRatio } = await import("../src/server/rag/citations");
  const { looksInternal } = await import("../src/server/rag/intents");
  const { summarize } = await import("../src/shared/stats");
  const { EVAL } = await import("../seed/eval-set");

  const K = env.ragTopK;
  const users = new Map((await prisma.user.findMany()).map((u) => [u.email, u]));
  resetCaches();

  // ---------------- retrieval ----------------
  type R = { id: string; kind: string; goldRank: number | null; topSim: number | null; abstain: boolean; leak: boolean; goldInEvidence: boolean; ranked: { title: string; sim: number; cov: number; collectionId: string }[]; scopeKey: string; ms: number };
  const rows: R[] = [];
  for (const c of EVAL) {
    const u = users.get(c.user);
    if (!u) throw new Error(`user ${c.user} not seeded`);
    const scope = await scopeFor(u.id);
    const t0 = performance.now();
    const { vec } = await embedQuery(c.question);
    const { ranked } = await searchCandidates(scope, c.question, vec);
    const ms = performance.now() - t0;
    const docOrder = [...new Set(ranked.map((e) => e.title))];
    const goldRank = c.goldTitle ? docOrder.indexOf(c.goldTitle) : -1;
    const pol = applyPolicy(ranked, K);
    rows.push({
      id: c.id,
      kind: c.kind,
      goldRank: goldRank >= 0 ? goldRank + 1 : null,
      topSim: pol.topSim,
      abstain: pol.abstain,
      // Leakage: anything outside the user's scope, or (forbidden cases) the gold doc at all.
      leak: ranked.some((e) => !scope.collectionIds.includes(e.collectionId)) || (c.kind === "forbidden" && goldRank >= 0),
      goldInEvidence: !!c.goldTitle && pol.evidence.some((e) => e.title === c.goldTitle),
      ranked: ranked.slice(0, 5).map((e) => ({ title: e.title, sim: Math.round(e.sim * 1000) / 1000, cov: Math.round(e.keywordCoverage * 100) / 100, collectionId: e.collectionId })),
      scopeKey: scope.key,
      ms,
    });
  }

  const holdoutIds = new Set(EVAL.filter((c) => c.split === "holdout").map((c) => c.id));
  const tuneRows = rows.filter((r) => !holdoutIds.has(r.id));
  const holdRows = rows.filter((r) => holdoutIds.has(r.id));
  const accOf = (rs: R[]) => rs.filter((r) => r.abstain === (r.kind === "unanswerable" || r.kind === "forbidden")).length / Math.max(1, rs.length);
  const answerable = rows.filter((r) => r.kind === "answerable" || r.kind === "injection");
  const shouldAbstain = rows.filter((r) => r.kind === "unanswerable" || r.kind === "forbidden");
  const recallAt = (k: number) => answerable.filter((r) => r.goldRank !== null && r.goldRank <= k).length / answerable.length;
  const mrr = answerable.reduce((a, r) => a + (r.goldRank ? 1 / r.goldRank : 0), 0) / answerable.length;
  const absAcc = (th?: { minSim: number; minSimKw: number }) => {
    let ok = 0;
    for (const c of EVAL) {
      const r = rows.find((x) => x.id === c.id)!;
      // Re-run policy from stored top candidates for threshold sweeps.
      const abst = th ? r.ranked.every((e) => !(e.sim >= th.minSim || (e.sim >= th.minSimKw && e.cov >= 0.5))) : r.abstain;
      const want = c.kind === "unanswerable" || c.kind === "forbidden";
      if (abst === want) ok++;
    }
    return ok / EVAL.length;
  };
  // Threshold sweep (report only; never auto-applied). Small eval sets overfit: prefer the
  // middle of the best-scoring region over its edge.
  const sweep: { minSim: number; minSimKw: number; acc: number }[] = [];
  for (let a = 0.4; a <= 0.8001; a += 0.01) for (let b = 0.3; b <= a + 1e-9; b += 0.01) sweep.push({ minSim: +a.toFixed(2), minSimKw: +b.toFixed(2), acc: absAcc({ minSim: a, minSimKw: b }) });
  const best = Math.max(...sweep.map((s) => s.acc));
  const bestRegion = sweep.filter((s) => s.acc === best);

  const retrieval = {
    k: K,
    cases: rows.length,
    recallAt1: recallAt(1),
    recallAt3: recallAt(3),
    recallAtK: recallAt(K),
    mrr,
    evidenceRecall: answerable.filter((r) => r.goldInEvidence).length / answerable.length,
    abstentionAccuracy: absAcc(),
    abstentionAccuracyTuneSplit: accOf(tuneRows),
    abstentionAccuracyHoldout: accOf(holdRows),
    holdoutCases: holdRows.length,
    falseAbstentions: answerable.filter((r) => r.abstain).map((r) => r.id),
    missedAbstentions: shouldAbstain.filter((r) => !r.abstain).map((r) => r.id),
    permissionLeaks: rows.filter((r) => r.leak).map((r) => r.id),
    topSimAnswerable: summarize(answerable.map((r) => r.topSim)),
    topSimShouldAbstain: summarize(shouldAbstain.map((r) => r.topSim)),
    thresholds: { current: { minSim: env.ragMinVectorSim, minSimKw: env.ragMinVectorSimWithKeyword }, bestAccuracy: best, bestRegion: { minSim: [Math.min(...bestRegion.map((s) => s.minSim)), Math.max(...bestRegion.map((s) => s.minSim))], minSimKw: [Math.min(...bestRegion.map((s) => s.minSimKw)), Math.max(...bestRegion.map((s) => s.minSimKw))] } },
    latencyMs: summarize(rows.map((r) => Math.round(r.ms))),
  };

  console.log("\n=== Retrieval (no LLM) ===");
  console.log(`cases ${rows.length} · Recall@1 ${pct(retrieval.recallAt1)} · Recall@3 ${pct(retrieval.recallAt3)} · Recall@${K} ${pct(retrieval.recallAtK)} · MRR ${retrieval.mrr.toFixed(3)} · gold in final evidence ${pct(retrieval.evidenceRecall)}`);
  console.log(`abstention accuracy ${pct(retrieval.abstentionAccuracy)} (thresholds ${env.ragMinVectorSim}/${env.ragMinVectorSimWithKeyword}); false abstentions: ${retrieval.falseAbstentions.join(",") || "none"}; missed abstentions: ${retrieval.missedAbstentions.join(",") || "none"}`);
  console.log(`abstention accuracy by split — tuning set ${pct(retrieval.abstentionAccuracyTuneSplit)} (n=${tuneRows.length}, in-sample) · held-out ${pct(retrieval.abstentionAccuracyHoldout)} (n=${holdRows.length})`);
  console.log(`permission leaks: ${retrieval.permissionLeaks.length ? retrieval.permissionLeaks.join(",") : "none"}`);
  console.log(`top cosine — answerable p50 ${retrieval.topSimAnswerable.p50?.toFixed(3)} min ${retrieval.topSimAnswerable.min?.toFixed(3)} · should-abstain p50 ${retrieval.topSimShouldAbstain.p50?.toFixed(3)} max ${retrieval.topSimShouldAbstain.max?.toFixed(3)}`);
  console.log(`sweep best accuracy ${pct(best)} for minSim ${retrieval.thresholds.bestRegion.minSim.join("–")}, minSimKw ${retrieval.thresholds.bestRegion.minSimKw.join("–")}`);
  console.log(`retrieval latency (embed+search, warm cache off) p50 ${retrieval.latencyMs.p50} ms p95 ${retrieval.latencyMs.p95} ms`);

  // ---------------- generation ----------------
  let generation: unknown = null;
  if (generate) {
    const p = { ...providers(), tts: null };
    type G = { id: string; kind: string; ok: boolean; abstained: boolean; answer: string; citedGold: boolean | null; citedAllGold: boolean | null; grounded: number | null; mustNotViolated: boolean; ttftMs: number | null; totalMs: number | null; outcome: string };
    const gens: G[] = [];
    for (const c of EVAL) {
      const u = users.get(c.user)!;
      const scope = await scopeFor(u.id);
      const clock = new TurnClock();
      const res = await runTurn(
        { providers: p, retrieve: (s, q, signal) => retrieve(s, q, { signal, bypassCache: true }), emit: () => undefined, sendAudio: () => undefined },
        { turnId: c.id, turnNum: 1, mode: "text", question: c.question, retrievalQuery: c.question, scope, history: [], speak: false, tts: {}, clock, signal: new AbortController().signal },
      );
      const cited = res.sources.filter((s) => res.cited.includes(s.marker));
      const passages = new Map(res.retrieval?.evidence.map((e, i) => [i + 1, e.text]) ?? []);
      const mustNotViolated = !!c.mustNot && c.mustNot.test(res.answer);
      let ok: boolean;
      if (c.kind === "answerable") ok = !res.abstained && !!c.expect?.test(res.answer);
      else if (c.kind === "injection") ok = !mustNotViolated && (!c.expect || c.expect.test(res.answer) || res.abstained);
      // Internal questions must abstain. Non-VIH questions may instead get labelled general
      // guidance (never with document citations).
      else ok = !mustNotViolated && (res.abstained || (res.grounding === "general" && !looksInternal(c.question) && res.cited.length === 0));
      gens.push({
        id: c.id,
        kind: c.kind,
        ok,
        abstained: res.abstained,
        answer: res.answer,
        citedGold: c.goldTitle && !res.abstained ? cited.some((s) => s.title === c.goldTitle) : null,
        citedAllGold: c.goldTitle && !res.abstained ? cited.length > 0 && cited.every((s) => s.title === c.goldTitle) : null,
        grounded: !res.abstained && cited.length ? supportedSentenceRatio(res.answer, passages) : null,
        mustNotViolated,
        ttftMs: clock.between("llmStart", "firstToken"),
        totalMs: clock.since("end"),
        outcome: res.outcome,
      });
      process.stdout.write(ok ? "." : "x");
    }
    const by = (k: string) => gens.filter((g) => g.kind === k);
    const ansd = gens.filter((g) => (g.kind === "answerable" || g.kind === "injection") && !g.abstained);
    generation = {
      providers: describeProviders(p),
      answerAccuracy: by("answerable").filter((g) => g.ok).length / by("answerable").length,
      abstentionCorrect: [...by("unanswerable"), ...by("forbidden")].filter((g) => g.ok).length / (by("unanswerable").length + by("forbidden").length),
      citationHasGold: ansd.filter((g) => g.citedGold).length / Math.max(1, ansd.length),
      citationAllGold: ansd.filter((g) => g.citedAllGold).length / Math.max(1, ansd.length),
      answersWithoutCitation: ansd.filter((g) => g.citedGold === false && g.citedAllGold === false).map((g) => g.id),
      groundedness: summarize(ansd.map((g) => (g.grounded === null ? null : Math.round(g.grounded * 100)))),
      injectionResisted: by("injection").filter((g) => !g.mustNotViolated).length / by("injection").length,
      permissionLeaksInAnswers: by("forbidden").filter((g) => g.mustNotViolated).map((g) => g.id),
      failures: gens.filter((g) => !g.ok).map((g) => ({ id: g.id, kind: g.kind, answer: g.answer })),
      llmTtftMs: summarize(gens.map((g) => g.ttftMs)),
      turnMs: summarize(gens.map((g) => g.totalMs)),
      cases: gens,
    };
    const gsum = generation as { answerAccuracy: number; abstentionCorrect: number; citationHasGold: number; citationAllGold: number; groundedness: { p50: number | null; min: number | null }; injectionResisted: number; permissionLeaksInAnswers: string[]; failures: { id: string; answer: string }[]; llmTtftMs: { p50: number | null; p95: number | null }; turnMs: { p50: number | null; p95: number | null } };
    console.log("\n\n=== Generation (configured LLM) ===");
    console.log(`answer accuracy ${pct(gsum.answerAccuracy)} · abstention correct ${pct(gsum.abstentionCorrect)} · cites gold source ${pct(gsum.citationHasGold)} · all citations gold ${pct(gsum.citationAllGold)}`);
    console.log(`groundedness (lexical heuristic, % supported sentences) p50 ${gsum.groundedness.p50} min ${gsum.groundedness.min} · injection resisted ${pct(gsum.injectionResisted)} · leaks in answers: ${gsum.permissionLeaksInAnswers.join(",") || "none"}`);
    console.log(`LLM TTFT p50 ${gsum.llmTtftMs.p50} ms p95 ${gsum.llmTtftMs.p95} ms · text turn total p50 ${gsum.turnMs.p50} ms p95 ${gsum.turnMs.p95} ms`);
    for (const f of gsum.failures) console.log(`  FAIL ${f.id}: ${f.answer.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  const out = { at: new Date().toISOString(), providers: describeProviders(), config: { k: K, candidates: env.ragCandidates, chunkWords: env.chunkTargetWords }, retrieval, perCase: rows, generation };
  fs.mkdirSync("bench-results", { recursive: true });
  const file = path.join("bench-results", `eval-rag-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);
  await prisma.$disconnect();
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
