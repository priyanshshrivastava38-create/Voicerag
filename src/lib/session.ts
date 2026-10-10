// Framework-free session primitives (no next/* imports), shared by the Next.js routes and the
// voice WebSocket server. Tokens are random; only their SHA-256 is stored.
import { prisma } from "./db";
import { randomToken, sha256 } from "./crypto";

export const SESSION_COOKIE = "voicerag_session";
export const SESSION_HOURS = 12;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "MEMBER";
}

export async function issueSessionToken(userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, expiresAt } });
  return { token, expiresAt };
}

export async function userFromToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const s = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date() || s.user.disabled) return null;
  return { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role };
}

export function tokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
