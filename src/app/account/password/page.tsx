import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { PASSWORD_MIN } from "@/server/user-admin";
import { ChangePasswordForm } from "@/components/change-password-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change password" };

export default async function Page() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <ChangePasswordForm required={!!user.mustChangePassword} email={user.email} minLength={PASSWORD_MIN} />;
}
