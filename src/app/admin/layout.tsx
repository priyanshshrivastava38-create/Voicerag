import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { TopNav } from "@/components/top-nav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/account/password");
  if (user.role !== "ADMIN") redirect("/");
  return (
    <div className="min-h-screen">
      <TopNav role={user.role} />
      <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
    </div>
  );
}
