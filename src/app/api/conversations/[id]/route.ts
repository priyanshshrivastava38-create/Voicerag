import { route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { audit } from "@/server/audit";

// Always scoped by owner: another user's conversation id yields 404 (IDOR guard).
export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  const c = await prisma.conversation.findFirst({
    where: { id, userId: user.id },
    include: { messages: { orderBy: { createdAt: "asc" }, include: { citations: { orderBy: { marker: "asc" } }, feedback: { where: { userId: user.id }, select: { rating: true } } } } },
  });
  if (!c) throw notFound();
  return c;
});

export const DELETE = route<{ id: string }>(async (_req, user, { id }) => {
  const r = await prisma.conversation.deleteMany({ where: { id, userId: user.id } });
  if (!r.count) throw notFound();
  await audit({ actorId: user.id, action: "conversation.deleted", targetType: "Conversation", targetId: id });
  return { ok: true };
});
