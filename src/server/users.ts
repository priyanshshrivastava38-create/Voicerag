import { prisma } from "@/lib/db";
import { createSession, destroySession } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "./audit";

export async function login(email: string, password: string, ip: string) {
  rateLimit(`login:${ip}`, 10, 10);
  const user = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } });
  // Same error and similar cost whether or not the user exists.
  const ok = user ? verifyPassword(String(password), user.passwordHash) : (hashPassword("timing-equalizer"), false);
  if (!user || !ok || user.disabled) {
    await audit({ actorId: user?.id ?? null, action: "auth.login_failed", details: { reason: !user ? "unknown_user" : user.disabled ? "disabled" : "bad_password" } });
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  await createSession(user.id);
  await audit({ actorId: user.id, action: "auth.logged_in", targetType: "User", targetId: user.id });
  return { id: user.id };
}

export async function logout() {
  await destroySession();
}
