import { route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { audit } from "@/server/audit";

export const GET = route(async (_req, user) => ({
  conversations: await prisma.conversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, updatedAt: true, _count: { select: { messages: true } } },
  }),
}));

// Clear all of the caller's own conversations (messages, citations, feedback cascade).
export const DELETE = route(async (_req, user) => {
  const r = await prisma.conversation.deleteMany({ where: { userId: user.id } });
  await audit({ actorId: user.id, action: "conversation.cleared_all", details: { count: r.count } });
  return { deleted: r.count };
});
