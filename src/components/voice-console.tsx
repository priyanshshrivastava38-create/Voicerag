"use client";
// Voice console: conversation controls, live state, streaming transcript with citations,
// expandable evidence, per-turn latency, feedback, text fallback and settings.
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { memo, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Icon, Logo } from "./brand";
import type { AssistantState, ServerMsg, SourceRef, TurnMetricsView, TurnOutcome } from "@/shared/protocol";
import { VoiceClient, type ConnState, type MicState } from "@/client/voice-client";

interface Turn {
  turnId: string;
  mode: "voice" | "text";
  question: string;
  answer: string;
  sources: SourceRef[];
  cited: number[];
  abstained: boolean;
  outcome: TurnOutcome | null;
  metrics: TurnMetricsView | null;
  messageId: string | null;
  searching: boolean;
  feedback: 1 | -1 | null;
  grounding?: "documents" | "overview" | "general" | "none";
}

const STATE_LABEL: Record<AssistantState, string> = {
  idle: "Ready when you are",
  listening: "Listening…",
  transcribing: "Transcribing…",
  searching: "Searching the knowledge base…",
  thinking: "Composing an answer…",
  speaking: "Speaking · talk anytime to interrupt",
};

/** Example questions per collection (only collections the user can search are shown). */
const SUGGESTIONS: Record<string, string> = {
  "People & HR": "How many days of annual leave do I get?",
  "IT & Security": "What's the minimum password length?",
  Engineering: "How quickly must a SEV1 page be acknowledged?",
  "Finance (restricted)": "What's the per diem for international travel?",
  General: "How many people can join a single Space?",
};

/** Related questions per collection, used for follow-up suggestions after an answer. */
const RELATED: Record<string, string[]> = {
  General: ["What products does VIH offer?", "What does ViH Shruti do?", "What is ViH Prana?", "How many days a week can I work from home?", "What time does the cafeteria open?"],
  "People & HR": ["How many days of annual leave do I get?", "How much paid sick leave do I get?", "How long is parental leave for the primary caregiver?", "How far in advance should I request leave?"],
  "IT & Security": ["What's the minimum password length?", "What should I do if I lose my laptop?", "Can I use USB drives on my work laptop?"],
  Engineering: ["How quickly must a SEV1 page be acknowledged?", "How many approvals does a pull request need?", "When are production deployments allowed?"],
  "Finance (restricted)": ["What's the per diem for international travel?", "What's the deadline for submitting expense claims?", "Can I fly premium economy on long flights?"],
};

const CONSENT_KEY = "voicerag.micConsent.v1";

export function VoiceConsole(props: {
  user: { name: string; role: "ADMIN" | "MEMBER" };
  collections: string[];
  providers: Record<string, string>;
  localities: Record<string, "local" | "cloud" | "test">;
}) {
  const clientRef = useRef<VoiceClient | null>(null);
  const [conn, setConn] = useState<ConnState>("disconnected");
  const [mic, setMic] = useState<MicState>("off");
  const [assistant, setAssistant] = useState<AssistantState>("idle");
  // Mic level changes ~15x/s: kept outside React state so only the meters re-render, not the console.
  const [levelStore] = useState(createLevelStore);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [partial, setPartial] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [text, setText] = useState("");
  const [speak, setSpeak] = useState(true);
  const [rate, setRate] = useState(180);
  const [consented, setConsented] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [viewer, setViewer] = useState<{ title: string; body: string; meta: string } | null>(null);
  const [history, setHistory] = useState<{ id: string; title: string | null; updatedAt: string }[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Follow new content only while the reader is at (or near) the bottom of the transcript. */
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const fail = useCallback((message: string, code = "ERROR") => setError({ code, message }), []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/conversations");
      if (r.ok) setHistory(((await r.json()) as { conversations: { id: string; title: string | null; updatedAt: string }[] }).conversations);
    } catch {
      /* history is non-essential; the next successful load refreshes it */
    }
  }, []);

  useEffect(() => {
    try {
      setConsented(localStorage.getItem(CONSENT_KEY) === "yes");
    } catch {
      /* storage unavailable */
    }
    void loadHistory();
    const c = clientRef;
    return () => c.current?.disconnect();
  }, [loadHistory]);

  // Keep the newest content in view, but never on the empty welcome screen (it would scroll the
  // mic button and heading away) and never while the reader has scrolled up to read earlier answers.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || (!turns.length && !partial) || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight; // instant: smooth scrolling on every streamed token stutters
  }, [turns, partial]);

  // Esc interrupts the assistant (unless a dialog is open, where Esc closes it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.querySelector('[role="dialog"]')) return; // the dialog closes itself
        if (document.querySelector("[data-dismissable]")) {
          setSettingsOpen(false);
          setSidebarOpen(false);
          return;
        }
        clientRef.current?.interrupt("user_stop");
      }
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [settingsOpen]);

  const patch = useCallback((turnId: string, f: (t: Turn) => Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.turnId === turnId ? { ...t, ...f(t) } : t))), []);

  const onServer = useCallback((m: ServerMsg) => {
    switch (m.t) {
      case "partial":
        setPartial(m.text);
        break;
      case "turn_start":
        stickToBottom.current = true; // a new question always brings the reader to the answer
        setPartial("");
        setError(null);
        setTurns((ts) => [...ts, { turnId: m.turnId, mode: m.mode, question: "", answer: "", sources: [], cited: [], abstained: false, outcome: null, metrics: null, messageId: null, searching: true, feedback: null }]);
        break;
      case "transcript":
        patch(m.turnId, () => ({ question: m.text }));
        break;
      case "evidence":
        patch(m.turnId, () => ({ sources: m.sources, searching: false }));
        break;
      case "token":
        patch(m.turnId, (t) => ({ answer: t.answer + m.text }));
        break;
      case "answer_done":
        // The final text can differ from the streamed tokens (e.g. a contradictory sentence removed).
        patch(m.turnId, () => ({ answer: m.text, cited: m.cited, abstained: m.abstained, messageId: m.messageId, grounding: m.grounding }));
        setAnnouncement(m.text.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, ""));
        void loadHistory();
        break;
      case "turn_end":
        patch(m.turnId, () => ({ outcome: m.outcome, metrics: m.metrics, searching: false }));
        break;
    }
  }, [loadHistory, patch]);

  function client() {
    if (!clientRef.current) {
      clientRef.current = new VoiceClient(
        {
          onServer,
          onState: (s) => {
            setConn(s.conn);
            setMic(s.mic);
            setAssistant(s.assistant);
            levelStore.set(s.level);
            setUserSpeaking(s.userSpeaking);
          },
          onError: (code, message) => setError({ code, message }),
        },
        { speak, rateWpm: rate },
      );
    }
    return clientRef.current;
  }

  async function start(conversationId: string | null = null) {
    if (!consented) {
      setShowConsent(true);
      return;
    }
    setError(null);
    await begin(conversationId);
  }

  /** Connect and start the mic; any failure is shown to the user (the text box keeps working). */
  async function begin(conversationId: string | null) {
    try {
      const c = client();
      await c.connect(conversationId);
      await c.startMic();
    } catch {
      fail("Voice could not start in this browser. You can still type your question below.");
    }
  }

  /** Ensure a connection exists for a typed question. */
  async function ensureConnected() {
    const c = client();
    if (conn === "disconnected") {
      try {
        await c.connect(null);
      } catch {
        fail("Couldn't connect to the assistant. Check your connection and try again.");
        return null;
      }
    }
    return c;
  }

  function stop() {
    clientRef.current?.disconnect();
    setPartial("");
  }

  async function sendText(e: React.FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    const c = await ensureConnected();
    if (!c) return;
    c.sendText(q);
    setText("");
  }

  const openSource = useCallback(async (s: SourceRef) => {
    const r = await fetch(`/api/chunks/${encodeURIComponent(s.chunkId)}`).catch(() => null);
    if (!r) {
      fail("Couldn't open the source: the server is unreachable.");
      return;
    }
    if (!r.ok) {
      setViewer({ title: s.title, body: "This source is no longer available (deleted, replaced, or outside your access).", meta: "" });
      return;
    }
    const c = (await r.json()) as { text: string; heading: string | null; pageStart: number | null; pageEnd: number | null; current: boolean; document: { title: string; collection: string; version: number; filename: string } };
    const loc = [c.heading && `Section: ${c.heading}`, c.pageStart && `Page ${c.pageStart}${c.pageEnd && c.pageEnd !== c.pageStart ? `–${c.pageEnd}` : ""}`].filter(Boolean).join(" · ");
    setViewer({ title: c.document.title, body: c.text, meta: `${c.document.collection} · ${c.document.filename} v${c.document.version}${loc ? ` · ${loc}` : ""}${c.current ? "" : " · (superseded version)"}` });
  }, [fail]);

  const rateTurn = useCallback(async (t: Turn, rating: 1 | -1, comment?: string): Promise<boolean> => {
    if (!t.messageId) return false;
    const r = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId: t.messageId, rating, ...(comment ? { comment } : {}) }) }).catch(() => null);
    if (r?.ok) {
      patch(t.turnId, () => ({ feedback: rating }));
      return true;
    }
    fail("Your feedback couldn't be saved. Please try again.");
    return false;
  }, [fail, patch]);

  async function resume(id: string) {
    const r = await fetch(`/api/conversations/${id}`).catch(() => null);
    if (!r?.ok) {
      fail(r?.status === 404 ? "That conversation no longer exists." : "Couldn't open that conversation. Please try again.");
      if (r?.status === 404) void loadHistory();
      return;
    }
    const c = (await r.json()) as { messages: { id: string; role: "USER" | "ASSISTANT"; text: string; turnId: string | null; abstained: boolean; interrupted: boolean; citations: { marker: number; chunkId: string | null; documentId: string; docTitle: string; page: number | null; heading: string | null; excerpt: string; score: number }[] }[] };
    const restored: Turn[] = [];
    for (let i = 0; i < c.messages.length; i++) {
      const m = c.messages[i];
      if (m.role !== "USER") continue;
      const a = c.messages[i + 1]?.role === "ASSISTANT" ? c.messages[i + 1] : null;
      restored.push({
        turnId: m.turnId ?? m.id,
        mode: "text",
        question: m.text,
        answer: a?.text ?? "",
        sources: (a?.citations ?? []).map((x) => ({ marker: x.marker, chunkId: x.chunkId ?? "", documentId: x.documentId, title: x.docTitle, collection: "", page: x.page, heading: x.heading, excerpt: x.excerpt, score: x.score })),
        cited: (a?.citations ?? []).map((x) => x.marker),
        abstained: a?.abstained ?? false,
        outcome: a?.interrupted ? "cancelled" : "answered",
        metrics: null,
        messageId: a?.id ?? null,
        searching: false,
        feedback: null,
      });
    }
    stickToBottom.current = true;
    setTurns(restored);
    stop();
    await start(id);
  }

  function newConversation() {
    setTurns([]);
    clientRef.current?.newConversation();
  }

  async function deleteConversation(id: string) {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    const r = await fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => null);
    if (!r?.ok) fail("Couldn't delete the conversation. Please try again.");
    void loadHistory();
  }

  async function clearHistory() {
    if (!confirm("Clear all of your conversations? This cannot be undone.")) return;
    const r = await fetch("/api/conversations", { method: "DELETE" }).catch(() => null);
    if (r?.ok) newConversation();
    else fail("Couldn't clear your history. Please try again.");
    void loadHistory();
  }

  function exportConversation() {
    const lines = [`# VIH VoiceRAG conversation`, `Exported ${new Date().toLocaleString()}`, ""];
    for (const t of turns) {
      lines.push(`**You:** ${t.question}`, "", `**VIH Assistant:** ${t.answer}`);
      const cited = t.sources.filter((x) => t.cited.includes(x.marker));
      if (cited.length) lines.push("", ...cited.map((x) => `[${x.marker}] ${x.title}${x.heading ? ` — ${x.heading}` : ""}${x.page ? `, p. ${x.page}` : ""}`));
      lines.push("", "---", "");
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `vih-voicerag-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function ask(q: string) {
    const c = await ensureConnected();
    c?.sendText(q);
  }

  const live = conn === "connected" || conn === "reconnecting" || conn === "connecting";
  const busy = assistant === "searching" || assistant === "thinking" || assistant === "speaking" || assistant === "transcribing";
  const anyCloud = Object.values(props.localities).includes("cloud");
  const orbState = !live ? "idle" : userSpeaking ? "listening" : assistant;
  const micBlocked = mic === "denied" || mic === "unavailable";
  const statusText = conn === "reconnecting" ? "Reconnecting…" : conn === "connecting" ? "Connecting…" : !live ? "Voice is off" : userSpeaking ? "Listening…" : assistant === "idle" && micBlocked ? "Type your question below" : STATE_LABEL[assistant];
  const micText = mic === "on" ? "Microphone on" : mic === "denied" ? "Microphone blocked" : mic === "requesting" ? "Waiting for permission…" : mic === "unavailable" ? "Microphone unavailable" : "Microphone off";
  const suggestions = [props.collections.includes("General") ? "What products does VIH offer?" : null, ...props.collections.map((c) => SUGGESTIONS[c])].filter((x): x is string => !!x).slice(0, 4);
  const asked = new Set(turns.map((t) => t.question.toLowerCase()));
  const lastTurn = turns[turns.length - 1];
  const followUps = (() => {
    if (!lastTurn || lastTurn.outcome === null || lastTurn.outcome === "cancelled") return [];
    const cited = lastTurn.sources.find((x) => lastTurn.cited.includes(x.marker));
    const pool = lastTurn.abstained || !cited ? props.collections.flatMap((c) => (RELATED[c] ?? []).slice(0, 1)) : RELATED[cited.collection] ?? [];
    return pool.filter((q) => !asked.has(q.toLowerCase())).slice(0, 3);
  })();
  const today = new Date().toDateString();
  const groups = [
    { label: "Today", items: history.filter((h) => new Date(h.updatedAt).toDateString() === today) },
    { label: "Earlier", items: history.filter((h) => new Date(h.updatedAt).toDateString() !== today) },
  ].filter((g) => g.items.length);
  const toggleVoice = () => (live ? stop() : start());

  return (
    <div className="flex h-screen supports-[height:100dvh]:h-dvh">
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} />}
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside data-dismissable={sidebarOpen ? "" : undefined} className={`${sidebarOpen ? "fixed inset-y-0 left-0 z-40 flex bg-vih-ink" : "hidden"} w-[272px] shrink-0 flex-col border-r hairline bg-black/30 md:static md:flex`}>
        <div className="flex h-16 items-center justify-between px-5">
          <Logo size={30} />
          <button className="rounded-lg p-1.5 text-white/50 hover:bg-white/5 md:hidden" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><Icon.X /></button>
        </div>
        <div className="px-4">
          <button onClick={newConversation} className="btn btn-ghost h-10 w-full justify-start px-3"><Icon.Plus /> New conversation</button>
        </div>
        <div className="mt-6 flex items-center justify-between px-5">
          <p className="eyebrow">History</p>
          {history.length > 0 && <button onClick={clearHistory} className="text-[11px] text-white/55 hover:text-rose-300">Clear all</button>}
        </div>
        <ul className="scroll-thin mt-2 flex-1 space-y-0.5 overflow-y-auto px-3 text-sm">
          {groups.map((g) => (
            <li key={g.label}>
              <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-white/50">{g.label}</p>
              <ul className="space-y-0.5">
          {g.items.map((h) => (
            <li key={h.id} className="group relative">
              <button onClick={() => { setSidebarOpen(false); void resume(h.id); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 pr-9 text-left text-white/70 transition hover:bg-white/5 hover:text-white">
                <Icon.Chat width={15} height={15} className="shrink-0 text-white/35" />
                <span className="truncate">{h.title ?? "Untitled"}</span>
              </button>
              <button type="button" aria-label={`Delete conversation: ${h.title ?? "Untitled"}`} title="Delete" onClick={() => deleteConversation(h.id)} className="absolute right-1.5 top-1/2 block -translate-y-1/2 rounded-md p-1.5 text-white/50 hover:bg-white/10 hover:text-rose-300 focus:block md:hidden md:group-hover:block md:group-focus-within:block">
                <Icon.Trash />
              </button>
            </li>
          ))}
              </ul>
            </li>
          ))}
          {!history.length && <li className="px-2.5 py-2 text-xs text-faint">Your conversations will appear here.</li>}
        </ul>
        <div className="border-t hairline px-3 py-3">
          <p className="eyebrow mb-1.5 px-2">Explore</p>
          {[["/about", "About VIH"], ["/how-it-works", "How it works"], ["/platform", "Platform & tech"]].map(([href, label]) => (
            <Link key={href} href={href} className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] text-white/60 transition hover:bg-white/5 hover:text-white">
              {label} <Icon.Chevron className="text-white/25" />
            </Link>
          ))}
        </div>
        <div className="border-t hairline p-4">
          {props.user.role === "ADMIN" && (
            <div className="mb-3 grid grid-cols-2 gap-2">
              <Link href="/admin/documents" className="btn btn-ghost h-9 text-[13px]"><Icon.Doc width={15} height={15} /> Documents</Link>
              <Link href="/admin/metrics" className="btn btn-ghost h-9 text-[13px]"><Icon.Chart width={15} height={15} /> Metrics</Link>
              <Link href="/admin/users" className="btn btn-ghost col-span-2 h-9 text-[13px]"><Icon.Shield width={15} height={15} /> Users &amp; access</Link>
            </div>
          )}
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: "var(--vih-gradient)" }}>
              {props.user.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{props.user.name}</div>
              <div className="text-xs text-faint">
                {props.user.role === "ADMIN" ? "Administrator" : "Member"} · <Link href="/account/password" className="underline hover:text-white">Change password</Link>
              </div>
            </div>
            <button title="Sign out" aria-label="Sign out" className="rounded-lg p-2 text-white/50 hover:bg-white/5 hover:text-white" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined); location.href = "/login"; }}>
              <Icon.LogOut />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────── */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b hairline px-3 sm:gap-4 sm:px-6">
          <button className="rounded-lg p-2 text-white/70 hover:bg-white/5 md:hidden" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="font-display truncate text-[15px] font-semibold text-white sm:text-[17px]">Knowledge Assistant</h1>
            <div className="mt-0.5 hidden items-center gap-1.5 overflow-hidden text-xs text-faint sm:flex">
              <span className="shrink-0">Searching</span>
              {props.collections.length ? props.collections.map((c) => <span key={c} className="truncate rounded-md bg-white/5 px-1.5 py-0.5 text-white/60">{c.replace(" (restricted)", "")}</span>) : <span className="text-rose-300">no collections</span>}
            </div>
          </div>
          <span className={`chip hidden sm:inline-flex ${anyCloud ? "border-amber-400/30 text-amber-200" : "border-emerald-400/25 text-emerald-200"}`} title={Object.entries(props.providers).map(([k, v]) => `${k}: ${v}`).join("\n")}>
            <Icon.Shield width={13} height={13} /> {anyCloud ? "Uses approved cloud AI" : "Processed on VIH servers"}
          </span>
          {turns.length > 0 && (
            <button aria-label="Export conversation" title="Export conversation (Markdown)" onClick={exportConversation} className="rounded-lg p-2 text-white/60 hover:bg-white/5 hover:text-white"><Icon.Upload className="rotate-180" /></button>
          )}
          <div className="relative" ref={settingsRef}>
            <button type="button" aria-label="Voice settings" aria-expanded={settingsOpen} aria-controls="voice-settings" onClick={() => setSettingsOpen((o) => !o)} className="rounded-lg p-2 text-white/60 hover:bg-white/5 hover:text-white"><Icon.Sliders /></button>
            {settingsOpen && (
              <div id="voice-settings" data-dismissable="" className="glass absolute right-0 top-11 z-30 w-72 rounded-xl p-4 shadow-2xl shadow-black/60">
                <p className="eyebrow mb-3">Voice settings</p>
                <label className="flex items-center justify-between text-sm text-white/80">
                  Spoken replies
                  <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={speak} onChange={(e) => { setSpeak(e.target.checked); clientRef.current?.updateConfig({ speak: e.target.checked }); }} />
                </label>
                <label className="mt-4 block text-sm text-white/80">
                  <span className="flex justify-between">Speaking speed <span className="tabular text-faint">{rate} wpm</span></span>
                  <input type="range" min={120} max={260} step={10} value={rate} aria-valuetext={`${rate} words per minute`} className="mt-2 w-full accent-violet-500" onChange={(e) => { const v = Number(e.target.value); setRate(v); clientRef.current?.updateConfig({ rateWpm: v }); }} />
                </label>
                <div className="mt-4 border-t hairline pt-3 text-[11px] leading-relaxed text-faint">
                  {Object.entries(props.providers).map(([k, v]) => <div key={k}><span className="uppercase text-white/40">{k}</span> · {v}</div>)}
                </div>
              </div>
            )}
          </div>
        </header>

        {error && (
          <div role="alert" className="mx-auto mt-4 flex w-full max-w-3xl items-start justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-200">
            <span>
              {error.message}
              {error.code === "SESSION_EXPIRED" && (
                <>
                  {" "}
                  <a href="/login" className="font-medium underline hover:text-white">Sign in</a>
                </>
              )}
            </span>
            <button type="button" className="text-rose-300 hover:text-white" onClick={() => setError(null)} aria-label="Dismiss"><Icon.X width={16} height={16} /></button>
          </div>
        )}

        <div
          ref={scrollRef}
          className="scroll-thin flex-1 overflow-y-auto"
          data-testid="transcript"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto w-full max-w-3xl space-y-7 px-4 py-8 sm:px-6">
            {!turns.length && !partial && (
              <div className="flex flex-col items-center pt-6 text-center">
                <button onClick={toggleVoice} aria-label={live ? "End voice conversation" : "Start voice conversation"} className="group relative rounded-full focus-visible:outline-offset-8">
                  <LiveOrb store={levelStore} state={orbState} className="h-28 w-28" maxGrow={0.18} gain={2.5} />
                  <span className="absolute inset-0 flex items-center justify-center text-white/90 opacity-80 transition group-hover:opacity-100">
                    {live ? <Icon.Stop width={26} height={26} /> : <Icon.Mic width={28} height={28} />}
                  </span>
                </button>
                <p className="mt-4 text-xs text-faint">
                  {live && micBlocked ? (
                    <>
                      Microphone {mic === "denied" ? "blocked" : "unavailable"} — type below or{" "}
                      <button type="button" className="underline hover:text-white" onClick={() => void clientRef.current?.startMic()}>try the mic again</button>
                    </>
                  ) : live ? (userSpeaking ? "Listening…" : "I'm listening — go ahead") : "Tap to talk"}
                </p>
                <h2 className="font-display mt-6 text-4xl font-semibold text-white">How can I help today?</h2>
                <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">Ask out loud or type below. Every answer comes from VIH documents with a source you can open.</p>

                <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2 text-left sm:grid-cols-3">
                  {[
                    ["1", "Tap to talk", "Allow the microphone once."],
                    ["2", "Ask naturally", "Pause when you're done."],
                    ["3", "Interrupt anytime", "Just speak, or press Esc."],
                  ].map(([n, t, d]) => (
                    <div key={n} className="rounded-xl border hairline bg-white/[0.02] p-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-md text-[11px] font-bold text-white" style={{ background: "var(--vih-gradient)" }}>{n}</span>
                        <span className="text-[13px] font-medium text-white">{t}</span>
                      </div>
                      <p className="mt-1 text-[12px] text-faint">{d}</p>
                    </div>
                  ))}
                </div>

                {suggestions.length > 0 && (
                  <>
                    <p className="eyebrow mt-10">Try asking</p>
                    <div className="mt-3 grid w-full max-w-2xl gap-2.5 sm:grid-cols-2">
                      {suggestions.map((q) => (
                        <button key={q} onClick={() => ask(q)} className="glass group flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm text-white/80 transition hover:border-violet-400/40 hover:text-white">
                          {q}
                          <Icon.Chevron className="shrink-0 text-white/30 transition group-hover:translate-x-0.5 group-hover:text-violet-300" />
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {props.collections.length > 0 && (
                  <p className="mt-6 text-xs text-faint">
                    I know about: {props.collections.map((c) => c.replace(" (restricted)", "")).join(" · ")}
                  </p>
                )}
              </div>
            )}
            {turns.map((t) => (
              <TurnView key={t.turnId} t={t} onSource={openSource} onRate={rateTurn} />
            ))}
            {followUps.length > 0 && !busy && (
              <div className="pl-10">
                <p className="mb-2 text-[12px] text-faint">{lastTurn?.abstained ? "I can help with these instead:" : "You might also ask:"}</p>
                <div className="flex flex-wrap gap-2">
                  {followUps.map((q) => (
                    <button key={q} onClick={() => ask(q)} className="rounded-full border hairline bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-white/75 transition hover:border-violet-400/40 hover:text-white">{q}</button>
                  ))}
                </div>
              </div>
            )}
            {partial && (
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md border border-dashed border-white/15 px-4 py-2.5 text-sm italic text-white/50" data-testid="partial">{partial}…</div>
              </div>
            )}
          </div>
        </div>

        {/* Screen-reader announcements (visible status is hidden on small screens). */}
        <div className="sr-only" role="status" aria-live="polite">{statusText}. {micText}.</div>
        <div className="sr-only" aria-live="polite">{announcement}</div>

        {/* ── Voice dock ────────────────────────────────────── */}
        <div className="shrink-0 px-3 pb-4 sm:px-6 sm:pb-6">
          <div className="glass mx-auto flex w-full max-w-3xl items-center gap-3 rounded-2xl p-2.5 pl-3 shadow-2xl shadow-black/50">
            <div className="flex items-center gap-3 pr-1">
              <button onClick={toggleVoice} aria-label={live ? "End voice conversation" : "Start voice conversation"} title={live ? "End voice" : "Tap to talk"} className="rounded-full">
                <LiveOrb store={levelStore} state={orbState} className="h-9 w-9 shrink-0" maxGrow={0.25} gain={3} />
              </button>
              {live && mic === "on" && <LevelBars store={levelStore} active={userSpeaking} />}
              <div className="hidden w-40 sm:block">
                <div className="truncate text-[13px] font-medium text-white" data-testid="assistant-state">
                  {statusText}
                  {(assistant === "thinking" || assistant === "searching" || assistant === "transcribing") && live && <span className="dots ml-1"><span /><span /><span /></span>}
                </div>
                <div className="text-[11px] text-faint">{micText}</div>
              </div>
            </div>
            <form onSubmit={sendText} className="flex min-w-0 flex-1 items-center gap-2">
              <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} ref={inputRef} placeholder="Ask anything about VIH…" className="input h-11 border-transparent bg-white/[0.04]" data-testid="text-input" aria-label="Question" />
              <button aria-label="Ask" className="btn btn-ghost h-11 w-11 shrink-0 p-0" disabled={!text.trim()}><Icon.Send /></button>
            </form>
            {busy && live && (
              <button onClick={() => clientRef.current?.interrupt("user_stop")} className="btn btn-ghost h-11 px-3" data-testid="interrupt" title="Interrupt"><Icon.Hand /> <span className="hidden lg:inline">Interrupt</span></button>
            )}
            {!live ? (
              <button onClick={() => start()} className="btn btn-primary h-11 px-4" data-testid="start"><Icon.Mic /> <span className="hidden sm:inline">Start conversation</span></button>
            ) : (
              <button onClick={stop} className="btn btn-danger h-11 px-4" data-testid="stop"><Icon.Stop /> <span className="hidden sm:inline">End</span></button>
            )}
          </div>
          <p className="mx-auto mt-2 max-w-3xl truncate text-center text-[11px] text-white/70 sm:hidden" aria-hidden>{statusText} · {micText}</p>
          <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-faint">AI answers can be wrong — check the cited source for anything important. Press Esc to interrupt.</p>
        </div>
      </main>

      {showConsent && (
        <Modal onClose={() => setShowConsent(false)} title="Enable voice">
          <div className="space-y-3 text-sm leading-relaxed text-white/70">
            <p>VIH VoiceRAG uses your microphone only while a conversation is running. Speech is detected in your browser, and only the parts where you speak are sent for transcription.</p>
            <ul className="space-y-1.5 rounded-xl border hairline bg-white/[0.03] p-3 text-[13px]">
              <li><span className="text-white/45">Speech recognition</span> · <span className="text-white">{props.providers.stt}</span></li>
              <li><span className="text-white/45">Answer generation</span> · <span className="text-white">{props.providers.llm}</span></li>
              <li><span className="text-white/45">Voice</span> · <span className="text-white">{props.providers.tts}</span></li>
            </ul>
            <p>Raw audio is never recorded or stored. Transcripts and answers stay in your conversation history according to the retention policy.</p>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button className="btn btn-ghost h-10 px-4" onClick={() => setShowConsent(false)}>Cancel</button>
            <button
              className="btn btn-primary h-10 px-4"
              data-testid="consent-accept"
              onClick={async () => {
                try {
                  localStorage.setItem(CONSENT_KEY, "yes");
                } catch {
                  /* storage unavailable */
                }
                setConsented(true);
                setShowConsent(false);
                setError(null);
                await begin(null);
              }}
            >
              <Icon.Mic /> Allow microphone & start
            </button>
          </div>
        </Modal>
      )}

      {viewer && (
        <Modal onClose={() => setViewer(null)} title={viewer.title}>
          <p className="mb-4 text-xs text-faint">{viewer.meta}</p>
          <blockquote className="whitespace-pre-wrap border-l-2 border-violet-400/60 pl-4 text-[14px] leading-relaxed text-white/85" data-testid="source-text">{viewer.body}</blockquote>
        </Modal>
      )}
    </div>
  );
}

const REASONS = ["Incorrect", "Incomplete", "Not what I asked", "Too slow"];

/** Memoised: while one answer streams, earlier turns don't re-render (or re-parse their text). */
const TurnView = memo(function TurnView({ t, onSource, onRate: rate }: { t: Turn; onSource: (s: SourceRef) => void; onRate: (t: Turn, r: 1 | -1, comment?: string) => Promise<boolean> }) {
  const onRate = (r: 1 | -1, comment?: string) => rate(t, r, comment);
  const [open, setOpen] = useState(false);
  const [askWhy, setAskWhy] = useState(false);
  const [thanks, setThanks] = useState(false);
  const cited = t.sources.filter((s) => t.cited.includes(s.marker));
  const shown = open ? t.sources : cited;
  return (
    <div className="space-y-3" data-testid="turn">
      {t.question && (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-vih-blue/90 to-vih-purple/80 px-4 py-2.5 text-[15px] text-white shadow-lg shadow-violet-900/30" data-testid="question">{t.question}</div>
        </div>
      )}
      <div className="flex gap-3">
        <img src="/brand/vih-icon.png" alt="" width={28} height={28} className="mt-1 h-7 w-7 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="glass rounded-2xl rounded-tl-md px-4 py-3">
            {!t.answer && t.outcome === null && (
              <div className="space-y-2 py-1" aria-label="Preparing answer">
                <span className="flex items-center gap-2 text-sm text-muted">{t.searching ? "Searching VIH documents" : "Writing the answer"} <span className="dots"><span /><span /><span /></span></span>
                <div className="h-2.5 w-3/4 animate-pulse rounded bg-white/[0.06]" />
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-white/[0.06]" />
              </div>
            )}
            <div className="text-[15px] leading-relaxed text-white/90" data-testid="answer">{renderAnswer(t.answer, t.sources, onSource)}</div>
            {(t.abstained || t.outcome === "cancelled" || t.outcome === "error" || t.outcome === "timeout" || t.metrics || t.messageId) && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t hairline pt-2.5 text-[11px] text-faint">
                {t.abstained && <span className="badge bg-amber-400/10 text-amber-200" data-testid="abstained">Not in knowledge base</span>}
                {t.grounding === "general" && <span className="badge bg-sky-400/10 text-sky-200" title="No VIH document covered this, so this is general guidance — verify before relying on it." data-testid="general">General guidance · not from VIH documents</span>}
                {t.grounding === "overview" && <span className="badge bg-white/10 text-white/70">Overview</span>}
                {t.outcome === "cancelled" && <span className="badge bg-white/10 text-white/70" data-testid="interrupted">Interrupted</span>}
                {t.outcome === "error" && <span className="badge bg-rose-500/15 text-rose-200">Error</span>}
                {t.outcome === "timeout" && <span className="badge bg-rose-500/15 text-rose-200">Timed out</span>}
                {t.metrics && <LatencyChips m={t.metrics} mode={t.mode} />}
                {t.messageId && (
                  <span className="ml-auto flex gap-1">
                    <CopyButton text={t.answer.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")} />
                    <button type="button" aria-label="Helpful" aria-pressed={t.feedback === 1} className={`rounded-md p-1.5 transition ${t.feedback === 1 ? "bg-emerald-400/15 text-emerald-300" : "text-white/40 hover:bg-white/5 hover:text-white"}`} onClick={async () => { setAskWhy(false); setThanks(await onRate(1)); }}><Icon.ThumbUp /></button>
                    <button type="button" aria-label="Not helpful" aria-pressed={t.feedback === -1} className={`rounded-md p-1.5 transition ${t.feedback === -1 ? "bg-rose-400/15 text-rose-300" : "text-white/40 hover:bg-white/5 hover:text-white"}`} onClick={async () => { setThanks(false); setAskWhy(await onRate(-1)); }}><Icon.ThumbDown /></button>
                  </span>
                )}
              </div>
            )}
            {askWhy && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="text-faint">What went wrong?</span>
                {REASONS.map((r) => (
                  <button key={r} onClick={async () => { setAskWhy(false); setThanks(await onRate(-1, r)); }} className="rounded-full border hairline px-2.5 py-1 text-white/70 hover:border-rose-400/40 hover:text-white">{r}</button>
                ))}
              </div>
            )}
            {thanks && <p role="status" className="mt-2 text-[12px] text-emerald-300/80">Thanks — your feedback helps improve answers.</p>}
          </div>
          {t.sources.length > 0 && (
            <div className="mt-2.5" data-testid="sources">
              <div className="grid gap-2 sm:grid-cols-2">
                {shown.map((s) => (
                  <button key={s.marker} onClick={() => onSource(s)} className="group flex items-start gap-3 rounded-xl border hairline bg-white/[0.02] p-3 text-left transition hover:border-violet-400/40 hover:bg-white/[0.04]" data-testid="source-link">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white" style={{ background: "var(--vih-gradient)" }}>{s.marker}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-white group-hover:text-violet-200">{s.title}</span>
                      <span className="block truncate text-[11.5px] text-faint">{[s.collection.replace(" (restricted)", ""), s.heading?.split(" > ").pop(), s.page ? `p. ${s.page}` : null].filter(Boolean).join(" · ")}</span>
                      {open && <span className="mt-1.5 line-clamp-3 block text-[12px] leading-relaxed text-white/55">{s.excerpt}</span>}
                    </span>
                  </button>
                ))}
              </div>
              {t.sources.length > cited.length && (
                <button className="mt-2 flex items-center gap-1 text-[12px] text-white/45 hover:text-white/80" onClick={() => setOpen(!open)}>
                  <Icon.Chevron className={`transition ${open ? "rotate-90" : ""}`} /> {open ? "Show cited only" : `Show all ${t.sources.length} retrieved passages`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState<string | null>(null);
  return (
    <button
      aria-label="Copy answer"
      title="Copy answer"
      className="rounded-md px-2 py-1 text-[11px] text-white/45 transition hover:bg-white/5 hover:text-white"
      onClick={async () => {
        const ok = await (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => true, () => false);
        setDone(ok ? "Copied" : "Copy failed");
        setTimeout(() => setDone(null), 1500);
      }}
    >
      {done ?? "Copy"}
    </button>
  );
}

/** Renders the answer with clickable citation pills and light formatting (paragraphs, lists, bold). */
function renderAnswer(text: string, sources: SourceRef[], onSource: (s: SourceRef) => void) {
  // Models sometimes inline numbered steps ("… 1. Do this 2. Do that"); put each on its own line.
  const normalized = text.replace(/\s+(?=\d+\.\s+[A-Z*])/g, "\n");
  const lines = normalized.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const inline = (line: string, key: string) =>
    line.split(/(\[\d+(?:\s*,\s*\d+)*\]|\*\*[^*]+\*\*)/g).map((p, i) => {
      const bold = /^\*\*([^*]+)\*\*$/.exec(p);
      if (bold) return <strong key={`${key}-${i}`} className="font-semibold text-white">{bold[1]}</strong>;
      const m = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(p);
      if (!m) return <span key={`${key}-${i}`}>{p.replace(/\*\*/g, "")}</span>;
      return (
        <span key={`${key}-${i}`}>
          {m[1].split(",").map((n) => {
            const s = sources.find((x) => x.marker === Number(n.trim()));
            // Only markers that map to supplied evidence become source links; anything else is plain text.
            return s ? (
              <button key={n} className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-0.5 items-center justify-center rounded-[5px] px-1 align-middle text-[10.5px] font-bold text-white" style={{ background: "var(--vih-gradient)" }} onClick={() => onSource(s)} title={s.title} aria-label={`Source ${n.trim()}: ${s.title}`}>
                {n.trim()}
              </button>
            ) : (
              <span key={n}>{n.trim()}</span>
            );
          })}
        </span>
      );
    });
  if (lines.length <= 1) return inline(text, "l");
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const item = /^(\d+\.|[-•*])\s+(.*)$/.exec(line);
        return item ? (
          <div key={i} className="flex gap-2.5">
            <span className="mt-[3px] flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-white/[0.07] px-1 text-[11px] font-semibold text-violet-200">{/^\d/.test(item[1]) ? item[1].replace(".", "") : "•"}</span>
            <span>{inline(item[2], `l${i}`)}</span>
          </div>
        ) : (
          <p key={i}>{inline(line, `l${i}`)}</p>
        );
      })}
    </div>
  );
}

function LatencyChips({ m, mode }: { m: TurnMetricsView; mode: "voice" | "text" }) {
  const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
  const detail = [m.sttMs !== null && `STT ${m.sttMs} ms`, m.retrievalMs !== null && `search ${m.retrievalMs} ms`, m.llmTtftMs !== null && `LLM first token ${m.llmTtftMs} ms`, m.ttsFirstChunkMs !== null && `TTS ${m.ttsFirstChunkMs} ms`].filter(Boolean).join(" · ");
  return (
    <>
      {m.eosToFirstAudioMs !== null && (
        <span className="badge tabular gap-1 bg-violet-400/10 text-violet-200" title={`Time until you heard the answer. ${detail}`}>
          <Icon.Bolt /> {mode === "voice" ? "Replied in" : "Spoke in"} {fmt(m.eosToFirstAudioMs)}
        </span>
      )}
      {m.speculativeHit && <span className="badge bg-emerald-400/10 text-emerald-200" title="Prepared while you paused">pre-rendered</span>}
      {m.retrievalCacheHit && <span className="badge bg-sky-400/10 text-sky-200">cached search</span>}
      {/* Hidden detail keeps the measured stage breakdown available to tests and power users. */}
      <span className="sr-only">EOS→audio {m.eosToFirstAudioMs} ms · {detail}</span>
    </>
  );
}

type LevelStore = ReturnType<typeof createLevelStore>;

/** Tiny external store for the mic level, read only by the meter components below. */
function createLevelStore() {
  let value = 0;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(v: number) {
      if (v === value) return;
      value = v;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

function useLevel(store: LevelStore) {
  return useSyncExternalStore(store.subscribe, store.get, () => 0);
}

function LiveOrb({ store, state, className, maxGrow, gain }: { store: LevelStore; state: string; className: string; maxGrow: number; gain: number }) {
  const level = useLevel(store);
  return <div className={`orb ${className}`} data-state={state} style={{ transform: `scale(${1 + Math.min(maxGrow, level * gain)})` }} />;
}

function LevelBars({ store, active }: { store: LevelStore; active: boolean }) {
  const level = useLevel(store);
  const v = Math.min(1, level * 9);
  return (
    <div className="flex h-7 items-center gap-[3px]" aria-hidden>
      {[0.55, 0.85, 1, 0.8, 0.5].map((k, i) => (
        <span key={i} className={`w-[3px] rounded-full transition-all duration-75 ${active ? "bg-violet-300" : "bg-white/25"}`} style={{ height: `${Math.max(4, v * k * 26)}px` }} />
      ))}
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Focus moves into the dialog, Tab stays inside it, and focus returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (items().at(-1) ?? ref.current)?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") return closeRef.current();
      if (e.key !== "Tab") return;
      const els = items();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("keydown", k);
      opener?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="glass max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-vih-panel/90 p-6 shadow-2xl shadow-black/60" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h3 id={titleId} className="font-display text-xl font-semibold text-white">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-white/40 hover:bg-white/5 hover:text-white"><Icon.X /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
