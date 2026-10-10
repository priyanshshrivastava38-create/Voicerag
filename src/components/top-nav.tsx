import Link from "next/link";
import { Icon, Logo } from "./brand";

/** Shared top navigation for the informational and admin pages. */
export function TopNav({ role }: { role: "ADMIN" | "MEMBER" }) {
  const link = "flex items-center gap-2 rounded-lg px-3 py-2 text-white/65 transition hover:bg-white/5 hover:text-white";
  return (
    <header className="sticky top-0 z-20 border-b hairline bg-black/50 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
        <Link href="/" className="shrink-0"><Logo size={28} /></Link>
        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-[13.5px]">
          <Link href="/about" className={link}>About VIH</Link>
          <Link href="/how-it-works" className={link}>How it works</Link>
          <Link href="/platform" className={link}>Platform</Link>
          {role === "ADMIN" && (
            <>
              <span className="mx-2 h-5 w-px bg-white/10" />
              <Link href="/admin/documents" className={link}><Icon.Doc width={15} height={15} /> Knowledge base</Link>
              <Link href="/admin/metrics" className={link}><Icon.Chart width={15} height={15} /> Performance</Link>
            </>
          )}
        </nav>
        <Link href="/" className="btn btn-primary ml-auto h-9 shrink-0 px-3.5 text-[13px]"><Icon.Mic width={15} height={15} /> Open assistant</Link>
      </div>
    </header>
  );
}
