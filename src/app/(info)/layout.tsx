import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { TopNav } from "@/components/top-nav";

export const dynamic = "force-dynamic";

export default async function InfoLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <div className="min-h-screen">
      <TopNav role={user.role} />
      <div className="mx-auto max-w-6xl px-6 pb-20 pt-12">{children}</div>
      <footer className="border-t hairline py-8 text-center text-xs text-faint">© VIH Metaverse Pvt. Ltd. · VIH VoiceRAG internal pilot</footer>
    </div>
  );
}
