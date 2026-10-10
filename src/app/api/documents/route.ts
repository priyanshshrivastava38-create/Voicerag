import { route } from "@/lib/api";
import { badRequest } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { listDocuments, uploadDocument } from "@/server/documents";

export const GET = route(async (req, user) => ({ documents: await listDocuments(user, req.nextUrl.searchParams.get("collectionId") ?? undefined) }));

export const POST = route(async (req, user) => {
  rateLimit(`upload:${user.id}`, 30, 30);
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const collectionId = String(form?.get("collectionId") ?? "");
  if (!(file instanceof File) || !collectionId) throw badRequest("file and collectionId are required.");
  const data = Buffer.from(await file.arrayBuffer());
  const documentId = form?.get("documentId") ? String(form.get("documentId")) : undefined;
  const title = form?.get("title") ? String(form.get("title")) : undefined;
  return uploadDocument(user, { collectionId, filename: file.name, data, documentId, title });
});
