"use client";
import Link from "next/link";
import { useState } from "react";
import { Icon, Logo } from "./brand";

export function ChangePasswordForm({ required, email, minLength }: { required: boolean; email: string; minLength: number }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setError("The new passwords don't match.");
    if (next.length < minLength) return setError(`Use at least ${minLength} characters.`);
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      if (r.ok) {
        location.href = "/";
        return;
      }
      if (r.status === 429) setError("Too many attempts. Wait a minute and try again.");
      else setError(((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "Couldn't change your password.");
    } catch {
      setError("Can't reach the server. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="glass w-full max-w-sm rounded-2xl p-8 shadow-2xl shadow-black/40">
        <div className="mb-8"><Logo size={32} /></div>
        <h1 className="font-display text-2xl font-semibold text-white">{required ? "Choose your password" : "Change password"}</h1>
        <p className="mt-1 text-sm text-muted">
          {required ? "You signed in with a temporary password from your administrator. Set your own to continue." : "Other devices will be signed out."}
        </p>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <div className="mt-7 space-y-4">
          <label className="block text-sm">
            <span className="mb-1.5 block text-white/70">{required ? "Temporary password" : "Current password"}</span>
            <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <div className="text-sm">
            <label className="block">
              <span className="mb-1.5 block text-white/70">New password</span>
              <input className="input" type="password" autoComplete="new-password" minLength={minLength} aria-describedby="pw-hint" value={next} onChange={(e) => setNext(e.target.value)} required />
            </label>
            <p id="pw-hint" className="mt-1 text-xs text-faint">At least {minLength} characters. A short phrase is easiest to remember.</p>
          </div>
          <div className="text-sm">
            <label className="block">
              <span className="mb-1.5 block text-white/70">Confirm new password</span>
              <input className="input" type="password" autoComplete="new-password" aria-invalid={mismatch} aria-describedby={mismatch ? "pw-mismatch" : undefined} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            {mismatch && <p id="pw-mismatch" className="mt-1 text-xs text-rose-300">Passwords don&apos;t match.</p>}
          </div>
        </div>
        {error && <p role="alert" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
        <button type="submit" disabled={busy} aria-busy={busy} className="btn btn-primary mt-6 h-11 w-full">{busy ? "Saving…" : "Save password"}</button>
        <div className="mt-6 flex items-center justify-between text-xs text-faint">
          <span className="flex items-center gap-2"><Icon.Lock /> Signed in as {email}</span>
          {required ? (
            <button type="button" className="underline hover:text-white" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined); location.href = "/login"; }}>Sign out</button>
          ) : (
            <Link href="/" className="underline hover:text-white">Cancel</Link>
          )}
        </div>
      </form>
    </main>
  );
}
