// Create the first administrator (or promote/re-enable an existing account) from the command line.
// Prints a one-time temporary password; the admin chooses their own at first sign-in.
//
//   npm run admin:create -- --email you@company.com --name "Your Name"
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const usage = 'Usage: npm run admin:create -- --email you@company.com --name "Your Name"\n(creates the account, or promotes and re-enables an existing one, with a one-time password)';
  if (process.argv.includes("--help")) {
    console.log(usage);
    return;
  }
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
    console.error(usage);
    process.exit(2);
  }
  const { prisma } = await import("../src/lib/db");
  const { hashPasswordAsync, temporaryPassword } = await import("../src/lib/crypto");
  const { audit } = await import("../src/server/audit");
  const password = temporaryPassword();
  const passwordHash = await hashPasswordAsync(password);
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const user = existing
    ? await prisma.user.update({ where: { email }, data: { name, role: "ADMIN", disabled: false, passwordHash, mustChangePassword: true } })
    : await prisma.user.create({ data: { email, name, role: "ADMIN", passwordHash, mustChangePassword: true } });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await audit({ action: existing ? "user.promoted_cli" : "user.created_cli", targetType: "User", targetId: user.id });
  console.log(`\n${existing ? "Updated" : "Created"} administrator ${email}`);
  console.log(`Temporary password: ${password}`);
  console.log("Sign in with it; you'll be asked to choose your own password. It is not shown again.\n");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
