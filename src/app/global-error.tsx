"use client";

// Last-resort boundary for errors in the root layout itself (replaces <html>, so no app styles).
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#05030b", color: "#f5f3ff", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: 24 }}>
        <div role="alert">
          <h1 style={{ fontSize: 24, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ opacity: 0.7, fontSize: 14 }}>VIH VoiceRAG hit an unexpected error.{error.digest ? ` Reference: ${error.digest}` : ""}</p>
          <button type="button" onClick={reset} style={{ marginTop: 16, padding: "10px 20px", borderRadius: 12, border: 0, background: "#7c3aed", color: "white", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
