// scrypt password hashing, session tokens and content hashes.
import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1 };

/** Async scrypt: runs on the libuv thread pool, so a login never stalls live voice sessions. */
function scryptAsync(password: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, len, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Readable one-time password for admin-issued accounts (no look-alike characters). */
export function temporaryPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Same cost as a real verification, for unknown users (no account-existence timing signal). */
export async function equalizeTiming(password: string): Promise<false> {
  await scryptAsync(password, crypto.randomBytes(16), 64);
  return false;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
