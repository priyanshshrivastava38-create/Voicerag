import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/crypto";
import { issueSessionToken, userFromToken } from "@/lib/session";
import { scopeFor } from "@/server/access";
import { changeOwnPassword, createGroup, createUser, deleteGroup, listUsers, resetPassword, updateGroup, updateUser } from "@/server/user-admin";
import { seeded } from "./helpers";

let s: Awaited<ReturnType<typeof seeded>>;
beforeAll(async () => {
  s = await seeded();
});

const group = async (name: string) => (await prisma.group.findUniqueOrThrow({ where: { name } })).id;
const collection = async (slug: string) => (await prisma.collection.findUniqueOrThrow({ where: { slug } })).id;

describe("admin-managed accounts", () => {
  it("creates a user with a one-time password that must be changed before use", async () => {
    const r = await createUser(s.admin, { email: " New.Person@Example.com ", name: "New Person", groupIds: [await group("all-staff")] });
    expect(r.email).toBe("new.person@example.com");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.mustChangePassword).toBe(true);
    expect(await verifyPassword(r.tempPassword, row.passwordHash)).toBe(true);

    const { token } = await issueSessionToken(r.id);
    const me = (await userFromToken(token))!;
    expect(me.mustChangePassword).toBe(true);

    await expect(changeOwnPassword(me, { currentPassword: "wrong", newPassword: "a perfectly long phrase" })).rejects.toThrow(/current password/);
    await expect(changeOwnPassword(me, { currentPassword: r.tempPassword, newPassword: "short" })).rejects.toThrow(/at least 12/);
    await changeOwnPassword(me, { currentPassword: r.tempPassword, newPassword: "a perfectly long phrase" });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.mustChangePassword).toBe(false);
    expect(await userFromToken(token)).toBeNull(); // old sessions end on password change
  });

  it("rejects duplicate emails and unknown groups", async () => {
    await expect(createUser(s.admin, { email: "alice@vih.test", name: "Dup" })).rejects.toThrow(/already exists/);
    await expect(createUser(s.admin, { email: "x@vih.test", name: "X", groupIds: ["nope"] })).rejects.toThrow(/no longer exist/);
    await expect(createUser(s.admin, { email: "not-an-email", name: "X" })).rejects.toThrow();
  });

  it("disabling a user signs them out everywhere", async () => {
    const { token } = await issueSessionToken(s.carol.id);
    expect(await userFromToken(token)).not.toBeNull();
    await updateUser(s.admin, s.carol.id, { disabled: true });
    expect(await userFromToken(token)).toBeNull();
    await updateUser(s.admin, s.carol.id, { disabled: false });
  });

  it("never lets an admin lock themselves out or remove the last active admin", async () => {
    await expect(updateUser(s.admin, s.admin.id, { disabled: true })).rejects.toThrow(/your own/);
    await expect(updateUser(s.admin, s.admin.id, { role: "MEMBER" })).rejects.toThrow(/your own/);
    // A second admin cannot demote the only other admin if that would leave none active.
    const other = await createUser(s.admin, { email: "admin2@vih.test", name: "Second Admin", role: "ADMIN" });
    const otherUser = { id: other.id, email: other.email, name: "Second Admin", role: "ADMIN" as const };
    await updateUser(otherUser, s.admin.id, { role: "MEMBER" }); // allowed: admin2 remains
    await expect(updateUser(s.admin, other.id, { disabled: true })).rejects.toThrow(/At least one active administrator/);
    await updateUser(otherUser, s.admin.id, { role: "ADMIN" });
  });

  it("password reset issues a new temporary password and ends sessions", async () => {
    const { token } = await issueSessionToken(s.bob.id);
    const r = await resetPassword(s.admin, s.bob.id);
    expect(await userFromToken(token)).toBeNull();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: s.bob.id } });
    expect(row.mustChangePassword).toBe(true);
    expect(await verifyPassword(r.tempPassword, row.passwordHash)).toBe(true);
  });

  it("group membership and grants change what a user can search on the next turn", async () => {
    const fin = await collection("finance");
    expect((await scopeFor(s.alice.id)).collectionIds).not.toContain(fin);
    await updateUser(s.admin, s.alice.id, { groupIds: [await group("all-staff"), await group("engineering"), await group("finance")] });
    expect((await scopeFor(s.alice.id)).collectionIds).toContain(fin);

    const g = await createGroup(s.admin, { name: "Contractors", collectionIds: [] });
    await updateUser(s.admin, s.carol.id, { groupIds: [g.id] });
    expect((await scopeFor(s.carol.id)).collectionIds).toEqual([]);
    await updateGroup(s.admin, g.id, { collectionIds: [await collection("general")] });
    expect((await scopeFor(s.carol.id)).collectionIds).toEqual([await collection("general")]);
    await deleteGroup(s.admin, g.id);
    expect((await scopeFor(s.carol.id)).collectionIds).toEqual([]);
  });

  it("lists users with their groups and status", async () => {
    const users = await listUsers();
    const alice = users.find((u) => u.email === "alice@vih.test")!;
    expect(alice.groups.map((g) => g.name)).toContain("engineering");
    expect(users.every((u) => !("passwordHash" in u))).toBe(true);
  });
});
