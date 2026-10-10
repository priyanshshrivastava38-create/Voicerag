// Lightweight intent handling that runs before (or instead of) document retrieval:
//  - topic overviews: "what can you do for engineering?" → what the user's documents cover
//  - internal vs general questions: decides whether a question with no evidence may get
//    clearly-labelled general guidance, or must be answered "not in the knowledge base".
// Everything here is permission-scoped: overviews only describe collections in the user's scope.
import { prisma } from "@/lib/db";
import type { Scope } from "../access";

const INTENT = /\b(what (can|could|do|would) (you|u) (do|know|help|cover|offer|tell)|what (you|u) (can|could) (do|help|tell)|how (can|could|do) (you|u) help|what do (you|u) (know|have|cover)|what (can|could|should) i ask|what topics|what('s| is) (covered|in (the )?\w+( docs| documents)?)|help me with|what kind of questions)\b/i;

const ALIASES: [RegExp, string][] = [
  [/\b(engineering|engineers?|developers?|dev|code|deploy\w*|on-?call|incidents?)\b/i, "engineering"],
  [/\b(hr|human resources|people|leave|holidays?|parental)\b/i, "hr"],
  [/\b(it|security|cyber|passwords?|laptops?)\b/i, "it-security"],
  [/\b(finance|financial|expenses?|travel|budget)\b/i, "finance"],
  [/\b(general|company|vih|products?|facilities)\b/i, "general"],
];

export function topicIntent(question: string): { isTopic: boolean; slug: string | null } {
  const q = question.trim();
  if (!INTENT.test(q)) return { isTopic: false, slug: null };
  const hit = ALIASES.find(([re]) => re.test(q.replace(INTENT, " ")));
  return { isTopic: true, slug: hit ? hit[1] : null };
}

const GENERIC_HEADINGS = /^(welcome|scope|overview|introduction|about this handbook|purpose and scope|1\. purpose and scope|contact|who we are)$/i;

function list(xs: string[]) {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Spoken overview of what the user's accessible documents cover (optionally one collection). */
export async function topicOverview(scope: Scope, slug: string | null): Promise<string> {
  const cols = await prisma.collection.findMany({ where: { id: { in: scope.collectionIds } }, select: { id: true, slug: true, name: true } });
  const clean = (n: string) => n.replace(/\s*\(restricted\)/i, "");
  if (!cols.length) return "I can't search any knowledge collections with your current access. Please ask an administrator to grant your group access.";
  const target = slug ? cols.find((c) => c.slug === slug) : null;
  if (slug && !target) {
    return `I can't search any documents on that topic for you. I can help with ${list(cols.map((c) => clean(c.name)))}.`;
  }
  const chosen = target ? [target] : cols;
  const docs = await prisma.document.findMany({ where: { collectionId: { in: chosen.map((c) => c.id) }, deletedAt: null, currentVersionId: { not: null } }, select: { title: true, collectionId: true } });
  const chunks = await prisma.chunk.findMany({ where: { collectionId: { in: chosen.map((c) => c.id) }, active: true }, select: { headingPath: true }, orderBy: { ordinal: "asc" } });
  const headings = [...new Set(chunks.map((c) => (c.headingPath ?? "").split(" > ").pop()!.replace(/^\d+(\.\d+)*\.?\s+/, "").trim()).filter((h) => h && !GENERIC_HEADINGS.test(h) && !docs.some((d) => d.title === h)))];
  if (target) {
    const titles = docs.map((d) => `the ${d.title}`);
    const topics = headings.slice(0, 7).map((h) => h.toLowerCase());
    return `For ${clean(target.name)}, I can answer questions from ${list(titles) || "its documents"}${topics.length ? `, covering ${list(topics)}` : ""}. Just ask, for example about ${topics[0] ?? "any of these"}.`;
  }
  const per = chosen.map((c) => `${clean(c.name)} (${docs.filter((d) => d.collectionId === c.id).length} documents)`);
  return `I can answer questions from VIH documents in ${list(per)}. Topics include ${list(headings.slice(0, 6).map((h) => h.toLowerCase()))}. Ask about any of them, or say "what can you do for engineering" for a specific area.`;
}

/**
 * Does the question concern VIH-internal information? If so, and there is no evidence, the
 * assistant must not answer from general knowledge. Conservative: when in doubt, it's internal.
 */
const INTERNAL = /\b(vih|our|ours|we|us|company|companies'?s?|policy|policies|leave|holidays?|salary|salaries|payroll|pay|bonus|benefits?|insurance|reimburs\w*|expenses?|per diem|claims?|budget|revenue|ceo|cto|cfo|founder|manager|hr|office|offices|desk|parking|cafeteria|canteen|onboarding|employees?|staff|colleagues?|team|teams|department|internal|confidential|customers?'? data|client data|spaces|shruti|buddhi|smriti|prana|messenger|peoplehub|flagship|vpn|laptop|account|password|access|badge|dress code|hotel|flights?|travel|meeting rooms?|deploy\w*|on-?call|sev\s?\d|incident|postmortem|pull requests?|code review|merge|main branch|share price|stock)\b/i;

export function looksInternal(question: string): boolean {
  return INTERNAL.test(question);
}
