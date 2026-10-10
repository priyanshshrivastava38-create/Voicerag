import { prisma } from "@/lib/db";
import { createSession, destroySession } from "@/lib/auth";
import { equalizeTiming, verifyPassword } from "@/lib/crypto";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "./audit";

export async function login(email: string, password: string, ip: string) {
  const normalized = String(email).trim().toLowerCase().slice(0, 254);
  if (!normalized || !password) throw new ApiError(400, "BAD_REQUEST", "Enter your email and password.");
  if (String(password).length > 256) throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  // Per client IP (brute force from one source) and per account (distributed guessing).
  rateLimit(`login:${ip}`, 10, 10);
  rateLimit(`login-user:${normalized}`, 10, 5);
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  // Same error and similar cost whether or not the user exists.
  const ok = user ? await verifyPassword(String(password), user.passwordHash) : await equalizeTiming(String(password));
  if (!user || !ok || user.disabled) {
    await audit({ actorId: user?.id ?? null, action: "auth.login_failed", details: { reason: !user ? "unknown_user" : user.disabled ? "disabled" : "bad_password" } });
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  await createSession(user.id);
  await audit({ actorId: user.id, action: "auth.logged_in", targetType: "User", targetId: user.id });
  return { id: user.id, mustChangePassword: user.mustChangePassword };
}

export async function logout() {
  await destroySession();
}
