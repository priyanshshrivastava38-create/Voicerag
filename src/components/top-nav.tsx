import Link from "next/link";
import { Icon, Logo } from "./brand";
import { NavLink } from "./nav-link";

/** Shared top navigation for the informational and admin pages. */
export function TopNav({ role }: { role: "ADMIN" | "MEMBER" }) {
  return (
    <header className="sticky top-0 z-20 border-b hairline bg-black/50 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
        <Link href="/" className="shrink-0"><Logo size={28} /></Link>
        <nav aria-label="Main" className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-[13.5px]">
          <NavLink href="/about">About VIH</NavLink>
          <NavLink href="/how-it-works">How it works</NavLink>
          <NavLink href="/platform">Platform</NavLink>
          {role === "ADMIN" && (
            <>
              <span className="mx-2 h-5 w-px bg-white/10" />
              <NavLink href="/admin/documents"><Icon.Doc width={15} height={15} /> Knowledge base</NavLink>
              <NavLink href="/admin/metrics"><Icon.Chart width={15} height={15} /> Performance</NavLink>
              <NavLink href="/admin/users"><Icon.Shield width={15} height={15} /> Users</NavLink>
            </>
          )}
        </nav>
        <Link href="/" className="btn btn-primary ml-auto h-9 shrink-0 px-3.5 text-[13px]"><Icon.Mic width={15} height={15} /> Open assistant</Link>
      </div>
    </header>
  );
}
