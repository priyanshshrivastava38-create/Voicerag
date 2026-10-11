import Link from "next/link";
import { Logo } from "@/components/brand";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
      <Logo size={32} />
      <div>
        <p className="eyebrow mb-3">404</p>
        <h1 className="font-display text-3xl font-semibold text-white">Page not found</h1>
        <p className="mt-2 text-sm text-muted">The page you asked for doesn&apos;t exist or has moved.</p>
      </div>
      <Link href="/" className="btn btn-primary h-11 px-6">Back to the assistant</Link>
    </main>
  );
}
