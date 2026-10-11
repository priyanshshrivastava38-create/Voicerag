import { currentUser } from "@/lib/auth";
import { UsersAdmin } from "@/components/users-admin";

export const metadata = { title: "Users & access" };

export default async function Page() {
  const user = await currentUser(); // the admin layout has already enforced an admin session
  return <UsersAdmin currentUserId={user?.id ?? ""} />;
}
