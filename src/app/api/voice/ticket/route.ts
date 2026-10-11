// Voice ticket for split hosting: the browser exchanges its session cookie for a 60 s ticket and
// presents it to the voice server on another site (see src/lib/voice-ticket.ts).
import { cookies } from "next/headers";
import { route } from "@/lib/api";
import { sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";
import { notFound } from "@/lib/errors";
import { SESSION_COOKIE } from "@/lib/session";
import { issueVoiceTicket } from "@/lib/voice-ticket";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, user) => {
  if (!env.voiceTicketSecret) throw notFound();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  return { ticket: issueVoiceTicket(user.id, sha256(token)) };
});
