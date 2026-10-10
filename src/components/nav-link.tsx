"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Top-nav link that marks the current page (aria-current + active style). */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2 rounded-lg px-3 py-2 transition hover:bg-white/5 hover:text-white ${active ? "bg-white/[0.06] text-white" : "text-white/65"}`}
    >
      {children}
    </Link>
  );
}
