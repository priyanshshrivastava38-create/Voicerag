"use client";
import Link from "next/link";
import { useEffect } from "react";
import { Logo } from "@/components/brand";

// Route-level error boundary: a friendly message and a retry instead of a blank screen.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
      <Logo size={32} />
      <div role="alert">
        <h1 className="font-display text-3xl font-semibold text-white">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">The page hit an unexpected error. Try again, or go back to the assistant.</p>
        {error.digest && <p className="mt-2 text-xs text-faint">Reference: {error.digest}</p>}
      </div>
      <div className="flex gap-3">
        <button type="button" onClick={reset} className="btn btn-primary h-11 px-6">Try again</button>
        <Link href="/" className="btn btn-ghost h-11 px-6">Home</Link>
      </div>
    </main>
  );
}
