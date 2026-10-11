// Short-lived voice tickets for split hosting (web UI and voice server on different sites).
// The session cookie is not sent cross-site, so the web host signs a ticket bound to the caller's
// session and the voice server accepts it in place of the cookie. Framework-free (no next/* imports).
import crypto from "node:crypto";
import { prisma } from "./db";
import { env } from "./env";
import type { AuthUser } from "./session";

export const VOICE_TICKET_TTL_MS = 60_000;

function sign(payload: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `sessionHash` is the stored SHA-256 of the session token, so revoking the session revokes the ticket. */
export function issueVoiceTicket(userId: string, sessionHash: string, now = Date.now()): string {
  const secret = env.voiceTicketSecret;
  if (!secret) throw new Error("VOICE_TICKET_SECRET is not set");
  const payload = Buffer.from(JSON.stringify({ u: userId, s: sessionHash, e: now + VOICE_TICKET_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export async function userFromVoiceTicket(ticket: string | undefined, now = Date.now()): Promise<AuthUser | null> {
  const secret = env.voiceTicketSecret;
  if (!secret || !ticket) return null;
  const [payload, sig] = ticket.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  let claims: { u?: unknown; s?: unknown; e?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.u !== "string" || typeof claims.s !== "string" || typeof claims.e !== "number" || claims.e < now) return null;
  const s = await prisma.session.findUnique({ where: { tokenHash: claims.s }, include: { user: true } });
  if (!s || s.userId !== claims.u || s.expiresAt < new Date(now) || s.user.disabled) return null;
  return { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role, mustChangePassword: s.user.mustChangePassword };
}
