import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listCollections } from "@/server/documents";
import { describeProviders, providers } from "@/server/providers/registry";
import { VoiceConsole } from "@/components/voice-console";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  const collections = (await listCollections(user)).filter((c) => c.searchable).map((c) => c.name);
  const p = providers();
  const localities = { stt: p.stt.locality, llm: p.llm.locality, tts: p.tts?.locality ?? "local", embed: p.embed.locality };
  return <VoiceConsole user={{ name: user.name, role: user.role }} collections={collections} providers={describeProviders(p)} localities={localities} />;
}
