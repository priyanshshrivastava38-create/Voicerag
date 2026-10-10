import { z } from "zod";
import { json, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";

const schema = z.object({ messageId: z.string().min(1).max(64), rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().max(1000).optional() }).strict();

export const POST = route(async (req, user) => {
  const body = schema.parse(await json(req));
  const msg = await prisma.message.findFirst({ where: { id: body.messageId, role: "ASSISTANT", conversation: { userId: user.id } }, select: { id: true } });
  if (!msg) throw notFound();
  await prisma.feedback.upsert({
    where: { messageId_userId: { messageId: msg.id, userId: user.id } },
    update: { rating: body.rating, comment: body.comment ?? null },
    create: { messageId: msg.id, userId: user.id, rating: body.rating, comment: body.comment ?? null },
  });
  return { ok: true };
});
