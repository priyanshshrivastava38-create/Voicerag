// How VIH VoiceRAG works: the voice → retrieval → answer → speech pipeline, explained, with
// stage timings pulled from recorded benchmark turns (never hard-coded).
import { prisma } from "@/lib/db";
import { summarize } from "@/shared/stats";

export const dynamic = "force-dynamic";

const STEPS = [
  { n: "01", title: "You speak", tech: "Browser · AudioWorklet", body: "Your browser captures audio at 16 kHz and a voice-activity detector finds where you start and stop talking. Only the parts where you speak are sent — never continuous recording." },
  { n: "02", title: "It listens for the end of your question", tech: "Energy VAD · 150 ms pause / 550 ms end", body: "A short pause starts work early; a longer silence confirms you've finished. If you keep talking, the early work is thrown away." },
  { n: "03", title: "Speech becomes text", tech: "whisper.cpp · on this server", body: "Speech recognition runs locally with a vocabulary hint for VIH terms like PeopleHub, SEV1 and per diem. Raw audio is never stored." },
  { n: "04", title: "It searches only what you may see", tech: "pgvector + full-text · permission filter in SQL", body: "Your question is matched by meaning and by keywords against the collections your team is granted. Restricted documents never reach the model for people without access." },
  { n: "05", title: "It writes a short, cited answer", tech: "LLM · grounded prompt · injection guard", body: "The model may only use the retrieved passages and must cite them. If the evidence isn't good enough, the system says so instead of guessing." },
  { n: "06", title: "It speaks while still thinking", tech: "Piper TTS · clause-by-clause streaming", body: "The first phrase is turned into speech as soon as it's written, so you hear the answer before it's finished. Talk at any time to interrupt." },
];

const PRINCIPLES = [
  ["Grounded, not guessed", "Answers come only from approved documents, with clickable citations to the exact section and page."],
  ["Permission-aware", "Each user's searchable collections are enforced inside the database query and checked again in code."],
  ["Honest when unsure", "Low-relevance evidence produces a clear “not in the knowledge base” answer — no model call, no invention."],
  ["Private by default", "Speech, search, generation and voice can all run on VIH infrastructure. Raw audio is never stored."],
  ["Resistant to manipulation", "Instructions hidden inside documents are stripped before the model sees them, and prompt leaks are blocked."],
  ["Measured, not claimed", "Every turn records stage-by-stage timings; the Performance dashboard shows real p50/p95/p99."],
];

async function measured() {
  const rows = await prisma.turnMetric.findMany({
    where: { source: { in: ["benchmark", "live"] }, mode: "voice", outcome: { in: ["answered", "abstained"] }, createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
    select: { sttMs: true, retrievalMs: true, llmTtftMs: true, ttsFirstChunkMs: true, clientEosToFirstAudioMs: true, speculativeHit: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return {
    n: rows.length,
    stt: summarize(rows.map((r) => r.sttMs)).p50,
    retrieval: summarize(rows.map((r) => r.retrievalMs)).p50,
    ttft: summarize(rows.map((r) => r.llmTtftMs)).p50,
    tts: summarize(rows.map((r) => r.ttsFirstChunkMs)).p50,
    perceived: summarize(rows.map((r) => r.clientEosToFirstAudioMs)).p50,
    prerender: rows.length ? Math.round((rows.filter((r) => r.speculativeHit).length / rows.length) * 100) : null,
  };
}

export default async function HowItWorksPage() {
  const m = await measured();
  const ms = (v: number | null) => (v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
  return (
    <div className="space-y-20">
      <section>
        <p className="eyebrow">How it works</p>
        <h1 className="font-display mt-4 max-w-3xl text-5xl font-semibold leading-[1.05] text-white">
          From your voice to a <span className="grad-text">cited, spoken answer.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">VIH VoiceRAG combines speech recognition, permission-aware retrieval-augmented generation (RAG) and streaming speech synthesis — overlapped so you hear the answer as early as possible.</p>
      </section>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((s) => (
          <article key={s.n} className="glass relative rounded-2xl p-6">
            <span className="font-display grad-text text-3xl font-semibold">{s.n}</span>
            <h2 className="mt-3 text-lg font-semibold text-white">{s.title}</h2>
            <p className="mt-1 text-[11.5px] font-medium uppercase tracking-wider text-violet-300/80">{s.tech}</p>
            <p className="mt-3 text-sm leading-relaxed text-white/65">{s.body}</p>
          </article>
        ))}
      </section>

      {/* Overlap timeline */}
      <section className="glass rounded-3xl p-8">
        <p className="eyebrow">The speed trick</p>
        <h2 className="font-display mt-2 text-2xl font-semibold text-white">It starts answering while you&apos;re still pausing</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">The moment you pause, the whole answer is prepared in the background — transcription, search, the first words of the answer and the first spoken phrase. Nothing is shown or played until the system is sure you&apos;ve finished. If you keep talking, it discards that work.</p>
        <div className="mt-8 space-y-2.5 text-xs">
          {[
            ["You speak", 0, 34, "bg-white/25"],
            ["Pause → end confirmed", 34, 14, "bg-white/10"],
            ["Transcribe", 37, 9, "bg-vih-blue/70"],
            ["Search permitted docs", 46, 3, "bg-indigo-400/70"],
            ["Write answer (streaming)", 49, 33, "bg-violet-500/70"],
            ["Speak (streaming)", 60, 40, "bg-fuchsia-500/70"],
          ].map(([label, start, width, cls]) => (
            <div key={label as string} className="flex items-center gap-4">
              <span className="w-44 shrink-0 text-right text-white/60">{label}</span>
              <div className="relative h-5 flex-1 rounded bg-white/[0.03]">
                <div className={`absolute top-0 h-5 rounded ${cls}`} style={{ left: `${start}%`, width: `${width}%` }} />
                <div className="absolute -bottom-1.5 -top-1.5 left-[48%] border-l border-dashed border-white/35" />
              </div>
            </div>
          ))}
          <div className="flex items-center gap-4"><span className="w-44" /><div className="relative h-4 flex-1"><span className="absolute left-[48%] -translate-x-1/2 text-[10.5px] text-white/55">↑ you finish speaking</span></div></div>
        </div>
        <p className="mt-8 text-[11px] text-faint">Diagram is illustrative; real timings are below.</p>
      </section>

      <section>
        <p className="eyebrow">Measured, not claimed</p>
        <h2 className="font-display mt-2 text-2xl font-semibold text-white">Median stage timings from recorded voice turns</h2>
        <p className="mt-2 text-sm text-muted">{m.n ? `Last 7 days · ${m.n} voice turns · current pilot hardware (local models).` : "No voice turns recorded yet — run a few questions or the benchmark."}</p>
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-6">
          {[["Speech-to-text", m.stt], ["Search", m.retrieval], ["First AI word", m.ttft], ["First audio chunk", m.tts], ["You stop → you hear", m.perceived]].map(([l, v]) => (
            <div key={l as string} className="glass rounded-2xl p-4">
              <div className="text-xs text-muted">{l}</div>
              <div className="font-display mt-1 text-2xl font-semibold text-white">{ms(v as number | null)}</div>
            </div>
          ))}
          <div className="glass rounded-2xl p-4">
            <div className="text-xs text-muted">Prepared during pause</div>
            <div className="font-display grad-text mt-1 text-2xl font-semibold">{m.prerender === null ? "—" : `${m.prerender}%`}</div>
          </div>
        </div>
      </section>

      <section>
        <p className="eyebrow">Design principles</p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {PRINCIPLES.map(([t, b]) => (
            <div key={t} className="rounded-2xl border hairline bg-white/[0.02] p-5">
              <h3 className="font-semibold text-white">{t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/60">{b}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
