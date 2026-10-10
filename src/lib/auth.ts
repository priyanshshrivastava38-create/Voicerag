// Next.js session helpers (cookies). Token primitives live in ./session (framework-free) so the
// voice WebSocket server can authenticate without importing next/headers.
// Development-grade identity (no SSO/MFA); see docs/SECURITY.md for the production path.
import { cookies } from "next/headers";
import { prisma } from "./db";
import { sha256 } from "./crypto";
import { forbidden, unauthorized } from "./errors";
import { env } from "./env";
import { type AuthUser, SESSION_COOKIE, issueSessionToken, userFromToken } from "./session";

export { SESSION_COOKIE, issueSessionToken, userFromToken, tokenFromCookieHeader, type AuthUser } from "./session";

export async function createSession(userId: string) {
  const { token, expiresAt } = await issueSessionToken(userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.secureCookies,
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  jar.delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<AuthUser | null> {
  return userFromToken((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<AuthUser> {
  const u = await currentUser();
  if (!u) throw unauthorized();
  return u;
}

export function requireAdmin(user: AuthUser) {
  if (user.role !== "ADMIN") throw forbidden("Administrator role required.");
}
