// Admin-managed accounts: users, groups and which collections each group may search.
//
// Accounts are created by an administrator with a one-time temporary password that the user must
// replace on first sign-in (no email infrastructure needed). Every change is audited, ends the
// affected user's sessions where access shrinks, and refreshes the cached authorisation scopes.
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPasswordAsync, temporaryPassword, verifyPassword } from "@/lib/crypto";
import { ApiError, badRequest, conflict, notFound } from "@/lib/errors";
import type { AuthUser } from "@/lib/session";
import { invalidateScopes } from "./access";
import { audit } from "./audit";

export const PASSWORD_MIN = 12;

const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);
const name = z.string().trim().min(1, "Enter a name.").max(120);
const role = z.enum(["ADMIN", "MEMBER"]);
const ids = z.array(z.string().min(1).max(64)).max(200);

export const createUserInput = z.object({ email, name, role: role.default("MEMBER"), groupIds: ids.default([]) });
export const updateUserInput = z.object({ name: name.optional(), role: role.optional(), groupIds: ids.optional(), disabled: z.boolean().optional() });
export const groupInput = z.object({ name: z.string().trim().min(1, "Enter a group name.").max(80), collectionIds: ids.default([]) });
export const updateGroupInput = z.object({ name: z.string().trim().min(1).max(80).optional(), collectionIds: ids.optional() });
export const changePasswordInput = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().max(256) });

export function passwordProblem(password: string, userEmail: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.toLowerCase().includes(userEmail.split("@")[0].toLowerCase())) return "Don't include your email name in your password.";
  if (/^(.)\1+$/.test(password)) return "Don't use a single repeated character.";
  return null;
}

// ------------------------------------------------------------------------------- users

export async function listUsers() {
  const users = await prisma.user.findMany({
    orderBy: [{ disabled: "asc" }, { name: "asc" }],
    select: { id: true, email: true, name: true, role: true, disabled: true, mustChangePassword: true, createdAt: true, groups: { select: { group: { select: { id: true, name: true } } } } },
  });
  return users.map(({ groups, ...u }) => ({ ...u, groups: groups.map((g) => g.group) }));
}

async function assertGroupsExist(groupIds: string[]) {
  if (!groupIds.length) return;
  const n = await prisma.group.count({ where: { id: { in: groupIds } } });
  if (n !== new Set(groupIds).size) throw badRequest("One or more groups no longer exist. Refresh and try again.");
}

export async function createUser(actor: AuthUser, input: z.input<typeof createUserInput>) {
  const data = createUserInput.parse(input);
  await assertGroupsExist(data.groupIds);
  if (await prisma.user.findUnique({ where: { email: data.email }, select: { id: true } })) throw conflict("A user with this email already exists.");
  const tempPassword = temporaryPassword();
  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      role: data.role,
      passwordHash: await hashPasswordAsync(tempPassword),
      mustChangePassword: true,
      groups: { create: [...new Set(data.groupIds)].map((groupId) => ({ groupId })) },
    },
    select: { id: true, email: true },
  });
  invalidateScopes();
  await audit({ actorId: actor.id, action: "user.created", targetType: "User", targetId: user.id, details: { role: data.role, groups: data.groupIds.length } });
  return { id: user.id, email: user.email, tempPassword };
}

/** True if, after removing `userId` from the active admins, at least one active admin remains. */
async function anotherActiveAdmin(userId: string) {
  return (await prisma.user.count({ where: { role: "ADMIN", disabled: false, id: { not: userId } } })) > 0;
}

export async function updateUser(actor: AuthUser, userId: string, input: z.input<typeof updateUserInput>) {
  const data = updateUserInput.parse(input);
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, disabled: true } });
  if (!target) throw notFound("User not found.");

  const losesAdmin = target.role === "ADMIN" && !target.disabled && (data.role === "MEMBER" || data.disabled === true);
  if (losesAdmin && userId === actor.id) throw badRequest("You can't remove your own administrator access or disable yourself. Ask another administrator.");
  if (losesAdmin && !(await anotherActiveAdmin(userId))) throw badRequest("At least one active administrator is required.");
  if (data.groupIds) await assertGroupsExist(data.groupIds);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { name: data.name, role: data.role, disabled: data.disabled } });
    if (data.groupIds) {
      await tx.groupMember.deleteMany({ where: { userId } });
      if (data.groupIds.length) await tx.groupMember.createMany({ data: [...new Set(data.groupIds)].map((groupId) => ({ groupId, userId })) });
    }
    // A disabled account is signed out everywhere immediately.
    if (data.disabled) await tx.session.deleteMany({ where: { userId } });
  });
  invalidateScopes();
  await audit({ actorId: actor.id, action: "user.updated", targetType: "User", targetId: userId, details: { fields: Object.keys(data) } });
  return { ok: true };
}

export async function resetPassword(actor: AuthUser, userId: string) {
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) throw notFound("User not found.");
  const tempPassword = temporaryPassword();
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPasswordAsync(tempPassword), mustChangePassword: true } }),
    prisma.session.deleteMany({ where: { userId } }),
  ]);
  await audit({ actorId: actor.id, action: "user.password_reset", targetType: "User", targetId: userId });
  return { tempPassword };
}

/** The signed-in user replaces their password (required after an admin-issued temporary one). */
export async function changeOwnPassword(user: AuthUser, input: z.input<typeof changePasswordInput>) {
  const data = changePasswordInput.parse(input);
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true, email: true } });
  if (!row) throw notFound();
  if (!(await verifyPassword(data.currentPassword, row.passwordHash))) throw new ApiError(400, "WRONG_PASSWORD", "Your current password is incorrect.");
  const problem = passwordProblem(data.newPassword, row.email);
  if (problem) throw badRequest(problem);
  if (data.newPassword === data.currentPassword) throw badRequest("Choose a password different from the current one.");
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPasswordAsync(data.newPassword), mustChangePassword: false } }),
    // Sign out other devices; the caller issues a fresh session for this one.
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ]);
  await audit({ actorId: user.id, action: "user.password_changed", targetType: "User", targetId: user.id });
}

// ------------------------------------------------------------------------------ groups

export async function listGroups() {
  const groups = await prisma.group.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, _count: { select: { members: true } }, grants: { select: { collectionId: true } } },
  });
  return groups.map((g) => ({ id: g.id, name: g.name, members: g._count.members, collectionIds: g.grants.map((x) => x.collectionId) }));
}

async function assertCollectionsExist(collectionIds: string[]) {
  if (!collectionIds.length) return;
  const n = await prisma.collection.count({ where: { id: { in: collectionIds } } });
  if (n !== new Set(collectionIds).size) throw badRequest("One or more collections no longer exist. Refresh and try again.");
}

export async function createGroup(actor: AuthUser, input: z.input<typeof groupInput>) {
  const data = groupInput.parse(input);
  await assertCollectionsExist(data.collectionIds);
  if (await prisma.group.findUnique({ where: { name: data.name }, select: { id: true } })) throw conflict("A group with this name already exists.");
  const g = await prisma.group.create({ data: { name: data.name, grants: { create: [...new Set(data.collectionIds)].map((collectionId) => ({ collectionId })) } }, select: { id: true } });
  invalidateScopes();
  await audit({ actorId: actor.id, action: "group.created", targetType: "Group", targetId: g.id, details: { collections: data.collectionIds.length } });
  return { id: g.id };
}

export async function updateGroup(actor: AuthUser, groupId: string, input: z.input<typeof updateGroupInput>) {
  const data = updateGroupInput.parse(input);
  if (!(await prisma.group.findUnique({ where: { id: groupId }, select: { id: true } }))) throw notFound("Group not found.");
  if (data.collectionIds) await assertCollectionsExist(data.collectionIds);
  if (data.name && (await prisma.group.findFirst({ where: { name: data.name, id: { not: groupId } }, select: { id: true } }))) throw conflict("A group with this name already exists.");
  await prisma.$transaction(async (tx) => {
    if (data.name) await tx.group.update({ where: { id: groupId }, data: { name: data.name } });
    if (data.collectionIds) {
      await tx.collectionGrant.deleteMany({ where: { groupId } });
      if (data.collectionIds.length) await tx.collectionGrant.createMany({ data: [...new Set(data.collectionIds)].map((collectionId) => ({ collectionId, groupId })) });
    }
  });
  // Retrieval scope is recomputed on the next turn; cached retrievals are keyed by scope.
  invalidateScopes();
  await audit({ actorId: actor.id, action: "group.updated", targetType: "Group", targetId: groupId, details: { fields: Object.keys(data) } });
  return { ok: true };
}

export async function deleteGroup(actor: AuthUser, groupId: string) {
  if (!(await prisma.group.findUnique({ where: { id: groupId }, select: { id: true } }))) throw notFound("Group not found.");
  await prisma.group.delete({ where: { id: groupId } }); // memberships and grants cascade
  invalidateScopes();
  await audit({ actorId: actor.id, action: "group.deleted", targetType: "Group", targetId: groupId });
  return { ok: true };
}
