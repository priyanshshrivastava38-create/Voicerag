// WebSocket upgrade authorisation (pure function of the HTTP request; unit/integration tested).
import type { IncomingMessage } from "node:http";
import { env } from "@/lib/env";
import { type AuthUser, tokenFromCookieHeader, userFromToken } from "@/lib/session";
import { userFromVoiceTicket } from "@/lib/voice-ticket";
import { VoiceSession } from "./session";

export type UpgradeDecision = { ok: true; user: AuthUser; source: "live" | "benchmark" } | { ok: false; status: number; reason: string };

export async function authorizeUpgrade(req: IncomingMessage, query: Record<string, unknown>): Promise<UpgradeDecision> {
  const origin = req.headers.origin;
  // Cross-site WebSocket hijacking defence: browsers always send Origin on WS upgrades. Besides our
  // own host, only origins listed in VOICE_ALLOWED_ORIGINS (the split-hosted web UI) are accepted.
  if (origin) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = null;
    }
    const allowed = parsed && (parsed.host === req.headers.host || env.voiceAllowedOrigins.includes(parsed.origin));
    if (!allowed) return { ok: false, status: 403, reason: "Forbidden" };
  }
  // Same-site clients send the session cookie; a split-hosted web UI sends a short-lived ticket.
  const ticket = typeof query.ticket === "string" ? query.ticket : undefined;
  const user = ticket ? await userFromVoiceTicket(ticket) : await userFromToken(tokenFromCookieHeader(req.headers.cookie));
  if (!user) return { ok: false, status: 401, reason: "Unauthorized" };
  if (user.mustChangePassword) return { ok: false, status: 403, reason: "Password Change Required" };
  if (!VoiceSession.canOpen(user.id)) return { ok: false, status: 429, reason: "Too Many Sessions" };
  // Benchmark runs are tagged so dashboards never mix them with live traffic.
  const source = query.source === "benchmark" && user.role === "ADMIN" ? "benchmark" : "live";
  return { ok: true, user, source };
}
