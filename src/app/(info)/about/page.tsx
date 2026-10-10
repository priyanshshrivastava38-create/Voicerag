// About VIH Metaverse — company overview from the public VIH Metaverse website copy.
import Link from "next/link";
import { Icon } from "@/components/brand";

const PRODUCTS = [
  { name: "ViH Messenger", tag: "Messaging SDK", desc: "Enterprise-grade IP2IP messaging SDK connecting your brand to customers through intelligent, always-on conversations.", features: ["Direct IP2IP enterprise messaging", "Embedded AI chatbot conversations", "Real-time engagement at scale", "SDK-first integration"] },
  { name: "ViH Shruti", tag: "AI Voicebot", desc: "Intelligent voice AI that handles customer interactions over voice channels with full conversational context.", features: ["Natural-language voice interactions", "Cross-channel context retention", "Multilingual voice support", "Seamless human-agent handoff"] },
  { name: "ViH Buddhi", tag: "Insight Engine", desc: "Mines support emails and documents to surface quality signals — turning unstructured data into actionable intelligence.", features: ["Automated email & document analysis", "Behaviour pattern extraction", "Support quality scoring", "Trend detection across streams"] },
  { name: "ViH Smriti", tag: "Meeting Intelligence", desc: "AI meeting companion that joins, records and analyses your meetings — delivering insights no one else catches.", features: ["Recording & transcription", "Multi-speaker attribution", "Cross-meeting context tracking", "Key notes & follow-ups"] },
];

const JOURNEY = [
  { step: "01", product: "Messenger", title: "Customer starts a chat", body: "A billing dispute arrives over chat. Messenger routes it to the AI chatbot, detects repeat frustration and flags escalation." },
  { step: "02", product: "Shruti", title: "They follow up by phone", body: "Shruti answers with full context from the chat, retrieves billing history and flags churn risk in real time." },
  { step: "03", product: "Buddhi", title: "They escalate by email", body: "Buddhi extracts invoice data from the attachments, links it to the case and spots the same failure across customers." },
  { step: "04", product: "Smriti", title: "The CX team meets", body: "Smriti records and analyses the review meeting, links it to prior interactions and generates action items." },
];

export default function AboutPage() {
  return (
    <div className="space-y-20">
      {/* Hero */}
      <section className="relative">
        <div className="pointer-events-none absolute -left-20 -top-10 h-72 w-72 rounded-full bg-vih-blue/20 blur-[100px]" />
        <div className="pointer-events-none absolute right-0 top-0 h-72 w-72 rounded-full bg-vih-purple/20 blur-[100px]" />
        <p className="eyebrow">About VIH Metaverse</p>
        <h1 className="font-display mt-4 max-w-3xl text-5xl font-semibold leading-[1.05] text-white">
          A customer-experience ecosystem built on <span className="grad-text">AI, Blockchain and the Metaverse.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
          VIH Metaverse connects enterprises with their customers at every touchpoint — delivering unparalleled experiences from first contact to lasting loyalty, and redefining how enterprises understand, engage and serve their customers.
        </p>
        <div className="mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
          {[["5", "AI products"], ["360°", "Omnichannel coverage"], ["4", "Channels unified"], ["1", "Intelligence layer"]].map(([v, l]) => (
            <div key={l} className="glass rounded-2xl p-4">
              <div className="font-display grad-text text-3xl font-semibold">{v}</div>
              <div className="mt-1 text-xs text-muted">{l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Products */}
      <section>
        <p className="eyebrow">The product suite</p>
        <h2 className="font-display mt-3 text-3xl font-semibold text-white">Four tools. One unified mission.</h2>
        <p className="mt-2 text-muted">Purpose-built AI products that work independently — and better together.</p>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {PRODUCTS.map((p) => (
            <article key={p.name} className="glass group rounded-2xl p-6 transition hover:border-violet-400/30">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-xl font-semibold text-white">{p.name}</h3>
                <span className="chip">{p.tag}</span>
              </div>
              <p className="mt-3 text-[15px] leading-relaxed text-white/70">{p.desc}</p>
              <ul className="mt-5 grid gap-2 text-sm text-white/75 sm:grid-cols-2">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--vih-gradient)" }} />{f}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      {/* Prana */}
      <section className="glass relative overflow-hidden rounded-3xl p-10">
        <div className="pointer-events-none absolute -right-20 -top-20 h-80 w-80 rounded-full bg-vih-purple/25 blur-[100px]" />
        <p className="eyebrow">The unified intelligence layer</p>
        <h2 className="font-display grad-text mt-3 text-5xl font-semibold">ViH Prana</h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-white/75">
          Every touchpoint — the chat, the voice call, the email, the meeting — feeds into ViH Prana. Prana stitches them into a single intelligence graph, generates automated triggers and gives the enterprise the omnichannel analytics to understand not just individual cases, but the systemic patterns behind them.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-2 text-sm">
          {["Messenger", "Shruti", "Buddhi", "Smriti"].map((x) => (
            <span key={x} className="flex items-center gap-2"><span className="chip px-3 py-1.5 text-[13px]">{x}</span><span className="text-white/30">→</span></span>
          ))}
          <span className="rounded-full px-4 py-1.5 text-[13px] font-semibold text-white" style={{ background: "var(--vih-gradient)" }}>ViH Prana</span>
        </div>
      </section>

      {/* Journey */}
      <section>
        <p className="eyebrow">Use case</p>
        <h2 className="font-display mt-3 text-3xl font-semibold text-white">From fragmented touchpoints to unified intelligence</h2>
        <p className="mt-2 max-w-2xl text-muted">A premium telecom customer&apos;s billing dispute bounces across chat, voice, email and meetings. With the VIH suite, context follows the customer.</p>
        <ol className="mt-8 grid gap-4 md:grid-cols-4">
          {JOURNEY.map((j) => (
            <li key={j.step} className="glass rounded-2xl p-5">
              <div className="flex items-center justify-between">
                <span className="font-display grad-text text-2xl font-semibold">{j.step}</span>
                <span className="chip">{j.product}</span>
              </div>
              <h3 className="mt-4 font-semibold text-white">{j.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/65">{j.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* VoiceRAG */}
      <section className="glass flex flex-col items-start justify-between gap-6 rounded-3xl p-8 md:flex-row md:items-center">
        <div>
          <p className="eyebrow">Where VoiceRAG fits</p>
          <h2 className="font-display mt-2 text-2xl font-semibold text-white">The same voice-AI DNA as Shruti — pointed inward.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">VIH VoiceRAG lets employees ask policy and product questions by voice and hear cited answers from approved internal documents. Try asking it: &ldquo;What does ViH Smriti do?&rdquo;</p>
        </div>
        <Link href="/" className="btn btn-primary h-11 shrink-0 px-5"><Icon.Mic /> Ask the assistant</Link>
      </section>
    </div>
  );
}
