"use client";
import { useState } from "react";
import { Icon, Logo } from "@/components/brand";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (r.ok) {
        const j = (await r.json().catch(() => ({}))) as { mustChangePassword?: boolean };
        location.href = j.mustChangePassword ? "/account/password" : "/";
        return; // keep the button disabled while navigating
      }
      if (r.status === 429) setError("Too many sign-in attempts. Wait a minute and try again.");
      else setError(((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "Sign-in failed.");
    } catch {
      setError("Can't reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden overflow-hidden border-r hairline lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -left-40 top-1/3 h-[520px] w-[520px] rounded-full bg-vih-blue/20 blur-[120px]" />
        <div className="pointer-events-none absolute -right-24 bottom-0 h-[460px] w-[460px] rounded-full bg-vih-purple/20 blur-[120px]" />
        <Logo size={36} />
        <div className="relative max-w-lg">
          <p className="eyebrow mb-4">Internal knowledge assistant</p>
          <p className="font-display text-5xl font-semibold leading-[1.05] text-white">
            Ask VIH anything.
            <br />
            <span className="grad-text">Hear the answer.</span>
          </p>
          <p className="mt-6 text-[15px] leading-relaxed text-muted">
            Speak naturally and get concise, cited answers from approved VIH Metaverse documents, limited to the collections your team can access.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-white/75">
            {["Answers cite the exact policy and page", "Permission-aware: you only hear what you're allowed to see", "Says so when the knowledge base doesn't cover it"].map((t) => (
              <li key={t} className="flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/5 text-violet-300"><Icon.Shield width={14} height={14} /></span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-faint">© VIH Metaverse · Internal use only · Pilot</p>
      </section>

      {/* Form */}
      <section className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="glass w-full max-w-sm rounded-2xl p-8 shadow-2xl shadow-black/40">
          <div className="mb-8 lg:hidden">
            <Logo size={32} />
          </div>
          <h1 className="font-display text-2xl font-semibold text-white">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Use your VIH account to continue.</p>
          <div className="mt-7 space-y-4">
            <label className="block text-sm">
              <span className="mb-1.5 block text-white/70">Email</span>
              <input className="input" type="email" autoComplete="username" placeholder="name@vih.test" aria-invalid={!!error} aria-describedby={error ? "login-error" : undefined} value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block text-white/70">Password</span>
              <input className="input" type="password" autoComplete="current-password" aria-invalid={!!error} aria-describedby={error ? "login-error" : undefined} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          </div>
          {error && <p id="login-error" role="alert" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
          <button type="submit" disabled={busy} aria-busy={busy} className="btn btn-primary mt-6 h-11 w-full">{busy ? "Signing in…" : "Sign in"}</button>
          <p className="mt-6 flex items-center gap-2 text-xs text-faint"><Icon.Lock /> Internal pilot · sessions expire after 12 hours.</p>
        </form>
      </section>
    </main>
  );
}
