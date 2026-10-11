// Query expansion for workplace shorthand. Spoken questions use abbreviations ("my PR", "deploy to
// prod", "sev one") that documents spell out, and embedding models match the abbreviation poorly
// (or to the wrong sense: "PR" → public relations). The expansion is appended to the query, never
// substituted, so the original wording still drives keyword search.
//
// Keep this list GENERIC (shorthand any company uses). Company-specific terms belong in
// RAG_QUERY_GLOSSARY, e.g. RAG_QUERY_GLOSSARY="peoplehub=HR portal; flagship=feature flags".

const BUILTIN: [RegExp, string][] = [
  [/\bprs?\b/i, "pull request code review"],
  [/\bprod\b/i, "production"],
  [/\bwfh\b/i, "work from home remote"],
  [/\b(pto|ooo)\b/i, "leave time off"],
  [/\b(2fa|mfa|two[- ]factor)\b/i, "multi-factor authentication"],
  [/\bsev\s*(one|1)\b/i, "SEV1"],
  [/\bsev\s*(two|2)\b/i, "SEV2"],
  [/\bsev\s*(three|3)\b/i, "SEV3"],
  [/\bpost[- ]?mortem\b/i, "postmortem"],
  [/\bci\b/i, "continuous integration"],
  [/\bhq\b/i, "headquarters"],
  [/\bmgr\b/i, "manager"],
];

function configured(): [RegExp, string][] {
  return (process.env.RAG_QUERY_GLOSSARY ?? "")
    .split(";")
    .map((pair) => pair.split("=").map((s) => s.trim()))
    .filter(([term, expansion]) => term && expansion)
    .map(([term, expansion]) => [new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), expansion]);
}

/** Append expansions for any shorthand in the query. Idempotent. */
export function expandQuery(query: string): string {
  const add: string[] = [];
  for (const [re, expansion] of [...BUILTIN, ...configured()]) {
    if (re.test(query) && !query.toLowerCase().includes(expansion.toLowerCase())) add.push(expansion);
  }
  return add.length ? `${query} (${add.join(", ")})` : query;
}
