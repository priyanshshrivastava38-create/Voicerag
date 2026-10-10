// WebSocket upgrade authorisation (pure function of the HTTP request; unit/integration tested).
import type { IncomingMessage } from "node:http";
import { type AuthUser, tokenFromCookieHeader, userFromToken } from "@/lib/session";
import { VoiceSession } from "./session";

export type UpgradeDecision = { ok: true; user: AuthUser; source: "live" | "benchmark" } | { ok: false; status: number; reason: string };

export async function authorizeUpgrade(req: IncomingMessage, query: Record<string, unknown>): Promise<UpgradeDecision> {
  const origin = req.headers.origin;
  // Cross-site WebSocket hijacking defence: browsers always send Origin on WS upgrades.
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) return { ok: false, status: 403, reason: "Forbidden" };
  }
  const user = await userFromToken(tokenFromCookieHeader(req.headers.cookie));
  if (!user) return { ok: false, status: 401, reason: "Unauthorized" };
  if (!VoiceSession.canOpen(user.id)) return { ok: false, status: 429, reason: "Too Many Sessions" };
  // Benchmark runs are tagged so dashboards never mix them with live traffic.
  const source = query.source === "benchmark" && user.role === "ADMIN" ? "benchmark" : "live";
  return { ok: true, user, source };
}
