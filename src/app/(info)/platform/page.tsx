// Platform: technology stack and feature inventory, with live provider configuration.
import { prisma } from "@/lib/db";
import { describeProviders, providers } from "@/server/providers/registry";
import { ARCHITECTURE, TECH_LAYERS } from "@/shared/tech-stack";

export const dynamic = "force-dynamic";

export const metadata = { title: "Platform" };

const CAPABILITIES: { area: string; items: [string, string][] }[] = [
  {
    area: "Voice & real-time",
    items: [
      ["AudioWorklet capture", "16 kHz mono PCM in 20 ms frames, resampled in the browser's audio thread"],
      ["Voice activity detection", "Adaptive-noise-floor VAD with pre-roll, pause and end-of-turn events; echo guard while speaking"],
      ["WebSocket transport", "One persistent, authenticated, origin-checked socket per session; binary audio both ways"],
      ["Barge-in", "Talking over the assistant stops playback instantly and cancels generation server-side"],
      ["Speculative pre-render", "Whole turn prepared during your pause behind an output gate; released only when confirmed"],
      ["Gapless streaming playback", "Web Audio scheduling of streamed PCM, stale-turn audio dropped by turn number"],
    ],
  },
  {
    area: "AI & retrieval (RAG)",
    items: [
      ["Speech-to-text", "whisper.cpp (Metal-accelerated) with domain vocabulary prompting; cloud STT pluggable"],
      ["Hybrid search", "pgvector HNSW cosine search + PostgreSQL full-text, fused with reciprocal-rank fusion"],
      ["Embeddings", "nomic-embed-text (768-d), content-hash embedding cache so unchanged text is never re-embedded"],
      ["Grounded generation", "Evidence-only prompt, mandatory [n] citations, citation validation against supplied passages"],
      ["Abstention policy", "Similarity + keyword-coverage thresholds tuned on a labelled set with a held-out split"],
      ["Streaming TTS", "Piper neural voices, clause-level segmentation so speech starts after the first few words"],
    ],
  },
  {
    area: "Knowledge management",
    items: [
      ["Document ingestion", "PDF (real page numbers), DOCX (heading hierarchy), Markdown and TXT"],
      ["Structure-aware chunking", "Chunks never cross sections; sentence overlap; heading path kept for citations"],
      ["Versioning & re-indexing", "Atomic version swap, idempotent retries, FOR UPDATE SKIP LOCKED job queue"],
      ["Collections & grants", "Group-based access per collection (HR, IT, Engineering, Finance, General)"],
      ["Deletion", "Removed from search instantly, files erased, quoted excerpts scrubbed"],
    ],
  },
  {
    area: "Security & privacy",
    items: [
      ["Permission-aware retrieval", "Authorisation scope enforced inside SQL and re-checked in code; scope-keyed caches"],
      ["Prompt-injection defence", "Evidence fencing, removal of AI-directed instructions, streaming system-prompt leak guard"],
      ["Auth & RBAC", "Hashed session tokens, scrypt passwords, Admin/Member roles, IDOR-safe 404s"],
      ["Web hardening", "CSRF origin checks, WebSocket origin check, rate limits, upload validation by magic bytes"],
      ["Privacy", "No raw audio stored, explicit microphone consent, data-minimised audit log, retention purge"],
    ],
  },
  {
    area: "Observability & quality",
    items: [
      ["Per-turn tracing", "Stage timestamps for STT, search, first token, first audio and playback (client-measured)"],
      ["Performance dashboard", "p50 / p95 / p99 by stage, cold vs warm, cache and pre-render hit rates, cost per turn"],
      ["RAG evaluation", "Recall@K, MRR, abstention accuracy, citation correctness, groundedness, injection tests"],
      ["Benchmarks", "Real-voice end-to-end benchmark and a labelled synthetic concurrency/failure load test"],
      ["Automated tests", "Unit, integration (real Postgres), browser E2E with a fake microphone, real-provider suite"],
    ],
  },
];

export default async function PlatformPage() {
  const p = providers();
  const desc = describeProviders(p);
  const [docs, chunks, collections] = await Promise.all([
    prisma.document.count({ where: { deletedAt: null } }),
    prisma.chunk.count({ where: { active: true } }),
    prisma.collection.count(),
  ]);
  const rows: [string, string, string][] = [
    ["Speech-to-text", desc.stt, p.stt.locality],
    ["Language model", desc.llm, p.llm.locality],
    ["Embeddings", desc.embed, p.embed.locality],
    ["Text-to-speech", desc.tts, p.tts?.locality ?? "local"],
  ];
  const techCount = TECH_LAYERS.reduce((n, l) => n + l.items.length, 0);
  const runsTone: Record<string, string> = {
    Browser: "bg-sky-400/10 text-sky-200",
    "App server": "bg-violet-400/10 text-violet-200",
    "AI services": "bg-fuchsia-400/10 text-fuchsia-200",
    Database: "bg-emerald-400/10 text-emerald-200",
    "Cloud (optional)": "bg-amber-400/10 text-amber-200",
    "Build & test": "bg-white/10 text-white/70",
  };
  return (
    <div className="space-y-20">
      {/* Hero */}
      <section className="relative">
        <div className="pointer-events-none absolute -left-24 -top-16 h-72 w-72 rounded-full bg-vih-blue/20 blur-[110px]" />
        <div className="pointer-events-none absolute right-0 top-0 h-72 w-72 rounded-full bg-vih-purple/20 blur-[110px]" />
        <p className="eyebrow">Platform & technology</p>
        <h1 className="font-display mt-4 max-w-3xl text-5xl font-semibold leading-[1.05] text-white">
          The technology behind <span className="grad-text">VIH VoiceRAG.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">A production-oriented voice AI platform: real-time audio in the browser, permission-aware retrieval-augmented generation, streaming speech — with measurement and security built in at every layer.</p>
        <div className="mt-10 grid max-w-4xl grid-cols-2 gap-3 md:grid-cols-4">
          {[[String(techCount), "Technologies in the stack"], [String(TECH_LAYERS.length), "Architecture layers"], [String(docs), "Documents indexed"], [String(collections), "Access-controlled collections"]].map(([v, l]) => (
            <div key={l} className="glass rounded-2xl p-4">
              <div className="font-display grad-text text-3xl font-semibold">{v}</div>
              <div className="mt-1 text-xs text-muted">{l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Architecture */}
      <section>
        <p className="eyebrow">Architecture</p>
        <h2 className="font-display mt-3 text-3xl font-semibold text-white">Four layers, one real-time pipeline</h2>
        <p className="mt-2 max-w-2xl text-muted">Audio flows down from the browser to the AI services; cited answers and synthesised speech stream back up — over a single persistent connection.</p>
        <div className="mt-8 space-y-2">
          {ARCHITECTURE.map((a, i) => (
            <div key={a.layer}>
              <div className="glass grid items-center gap-4 rounded-2xl p-4 md:grid-cols-[180px_1fr]">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl font-display text-sm font-semibold text-white" style={{ background: "var(--vih-gradient)" }}>{i + 1}</span>
                  <div>
                    <div className="font-display text-[15px] font-semibold text-white">{a.layer}</div>
                    <div className="text-[11px] uppercase tracking-wider text-faint">{a.detail}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  {a.parts.map((p) => (
                    <div key={p} className="rounded-xl border hairline bg-white/[0.03] px-3 py-2.5 text-center text-[13px] text-white/80">{p}</div>
                  ))}
                </div>
              </div>
              {i < ARCHITECTURE.length - 1 && (
                <div className="flex justify-center py-1 text-[11px] text-white/30">
                  <span>↓ audio, queries&nbsp;&nbsp;·&nbsp;&nbsp;answers, speech ↑</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Live configuration */}
      <section className="glass rounded-2xl p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="eyebrow">Live configuration</p>
            <h2 className="font-display mt-2 text-xl font-semibold text-white">What this deployment is running right now</h2>
          </div>
          <span className="text-xs text-faint">{chunks} searchable passages</span>
        </div>
        <table className="mt-5 w-full text-sm">
          <tbody>
            {rows.map(([k, v, loc]) => (
              <tr key={k} className="border-t hairline first:border-0">
                <td className="py-3 pr-4 text-white/55">{k}</td>
                <td className="py-3 font-medium text-white">{v.replace(/ \((local|cloud|test)\)$/, "")}</td>
                <td className="py-3 text-right">
                  <span className={`badge ${loc === "cloud" ? "bg-amber-400/10 text-amber-200" : "bg-emerald-400/10 text-emerald-200"}`}>{loc === "cloud" ? "Cloud" : loc === "test" ? "Test" : "On VIH servers"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Technology catalogue */}
      <section>
        <p className="eyebrow">Technology catalogue</p>
        <h2 className="font-display mt-3 text-3xl font-semibold text-white">Every component, with version and role</h2>
        <div className="mt-10 space-y-12">
          {TECH_LAYERS.map((layer) => (
            <div key={layer.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b hairline pb-3">
                <h3 className="font-display text-xl font-semibold text-white">{layer.title}</h3>
                <p className="text-sm text-faint">{layer.summary}</p>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {layer.items.map((t) => (
                  <div key={t.name} className="glass flex gap-3.5 rounded-2xl p-4 transition hover:border-violet-400/30">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border hairline bg-white/[0.04] font-display text-[13px] font-semibold text-white">
                      {t.name.replace(/[^A-Za-z0-9 ]/g, "").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-white">{t.name}</span>
                        <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] text-white/60">{t.version}</span>
                      </div>
                      <p className="mt-1 text-[13px] leading-relaxed text-white/60">{t.role}</p>
                      <span className={`badge mt-2 ${runsTone[t.runs]}`}>{t.runs}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Capabilities */}
      <section>
        <p className="eyebrow">Capabilities</p>
        <h2 className="font-display mt-3 text-3xl font-semibold text-white">What the platform does</h2>
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          {CAPABILITIES.map((g) => (
            <div key={g.area} className="glass rounded-2xl p-6">
              <h3 className="font-display text-lg font-semibold text-white">{g.area}</h3>
              <ul className="mt-4 space-y-3">
                {g.items.map(([t, b]) => (
                  <li key={t} className="flex gap-3">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--vih-gradient)" }} />
                    <div>
                      <div className="text-sm font-medium text-white">{t}</div>
                      <div className="text-[13px] leading-relaxed text-white/55">{b}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
