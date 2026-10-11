"use client";
import { useCallback, useEffect, useState } from "react";

interface Collection { id: string; name: string; slug: string; documents: number; groups?: string[]; searchable: boolean }
interface Doc { id: string; title: string; filename: string; collection: string; collectionId: string; status: string; error: string | null; version: number; liveVersion: number | null; chunks: number; pages: number | null; updatedAt: string }

const ACCEPTED = [".pdf", ".docx", ".txt", ".md", ".markdown"];

/** Error message from an API response, tolerating non-JSON bodies (e.g. a proxy's 413 page). */
async function errorMessage(r: Response, fallback: string) {
  if (r.status === 413) return "File is too large for the server to accept.";
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  return j.error?.message ?? fallback;
}

export function DocumentsAdmin({ maxUploadMb }: { maxUploadMb: number }) {
  const [cols, setCols] = useState<Collection[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [collectionId, setCollectionId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cr, dr] = await Promise.all([fetch("/api/collections"), fetch("/api/documents")]);
      if (!cr.ok || !dr.ok) throw new Error(await errorMessage(cr.ok ? dr : cr, "Could not load the knowledge base."));
      const [c, d] = await Promise.all([cr.json(), dr.json()]);
      setCols(c.collections ?? []);
      setDocs(d.documents ?? []);
      setCollectionId((x) => x || c.collections?.[0]?.id || "");
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Can't reach the server. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while anything is being indexed.
  useEffect(() => {
    if (!docs.some((d) => d.status === "QUEUED" || d.status === "PROCESSING")) return;
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [docs, load]);

  function pickFile(f: File | null) {
    const name = f?.name ?? "";
    const problem = !f
      ? null
      : !ACCEPTED.some((ext) => name.toLowerCase().endsWith(ext))
        ? `"${name}" is not a supported type. Use PDF, DOCX, TXT or Markdown.`
        : f.size > maxUploadMb * 1024 * 1024
          ? `"${name}" is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is ${maxUploadMb} MB.`
          : null;
    setMsg(problem);
    if (problem) setInputKey((k) => k + 1); // clear the rejected file from the input
    setFile(problem ? null : f);
  }

  async function upload(e: React.FormEvent, documentId?: string) {
    e.preventDefault();
    if (!file || !collectionId) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("collectionId", collectionId);
    if (documentId) fd.set("documentId", documentId);
    try {
      const r = await fetch("/api/documents", { method: "POST", body: fd });
      if (r.ok) {
        const j = (await r.json().catch(() => ({}))) as { duplicate?: boolean };
        setMsg(j.duplicate ? "Identical content is already indexed — nothing to do." : "Uploaded. Indexing in the background…");
        setFile(null);
        setInputKey((k) => k + 1); // remount the file input to clear it
      } else {
        setMsg(await errorMessage(r, "Upload failed."));
      }
    } catch {
      setMsg("Upload failed: can't reach the server.");
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function act(d: Doc, action: "reindex" | "delete") {
    if (action === "delete" && !confirm(`Delete "${d.title}"? It is removed from search immediately and its stored file is erased.`)) return;
    setPending(d.id);
    setMsg(null);
    try {
      const r = await fetch(action === "delete" ? `/api/documents/${d.id}` : `/api/documents/${d.id}/reindex`, { method: action === "delete" ? "DELETE" : "POST" });
      if (!r.ok) setMsg(await errorMessage(r, "Action failed."));
      else setMsg(action === "delete" ? `Deleted "${d.title}".` : `Re-indexing "${d.title}"…`);
    } catch {
      setMsg("Action failed: can't reach the server.");
    } finally {
      setPending(null);
      void load();
    }
  }

  return (
    <div className="space-y-6">
      <section className="glass rounded-2xl p-5">
        <p className="eyebrow mb-2">Administration</p>
        <h1 className="font-display text-2xl font-semibold text-white">Knowledge base</h1>
        <p className="mt-1 text-sm text-faint">Upload approved PDF, DOCX, TXT or Markdown documents. Only groups granted a collection can retrieve from it.</p>
        <form onSubmit={(e) => upload(e)} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-white/65">Collection</span>
            <select className="input mt-1.5 !w-auto min-w-48" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} disabled={!cols.length}>
              {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-white/65">File</span>
            <input key={inputKey} id="file" type="file" accept=".pdf,.docx,.txt,.md,.markdown" className="mt-1.5 block text-sm text-white/60 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-white/15" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            <span className="mt-1 block text-xs text-faint">PDF, DOCX, TXT or Markdown · up to {maxUploadMb} MB</span>
          </label>
          <button type="submit" disabled={!file || !collectionId || busy} className="btn btn-primary h-10 px-4">{busy ? "Uploading…" : "Upload"}</button>
        </form>
        {msg && <p className="mt-3 text-sm text-white/80" role="status">{msg}</p>}
        {loadError && (
          <div role="alert" className="mt-3 flex items-center gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {loadError}
            <button type="button" className="underline hover:text-rose-200" onClick={() => void load()}>Retry</button>
          </div>
        )}
      </section>

      <section className="glass rounded-2xl p-5">
        <h2 className="font-display mb-4 text-lg font-semibold text-white">Collections</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cols.map((c) => (
            <div key={c.id} className="rounded-xl border hairline bg-white/[0.02] p-4 text-sm">
              <div className="font-medium text-white">{c.name}</div>
              <div className="text-xs text-faint">{c.documents} document{c.documents === 1 ? "" : "s"} · groups: {c.groups?.join(", ") || "none"}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-x-auto glass rounded-2xl">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-left text-[11px] uppercase tracking-wider text-faint">
            <tr><th className="p-3">Document</th><th className="p-3">Collection</th><th className="p-3">Status</th><th className="p-3">Version</th><th className="p-3">Chunks</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-t hairline" data-testid="doc-row">
                <td className="p-3"><div className="font-medium text-white">{d.title}</div><div className="text-xs text-faint">{d.filename}{d.pages ? ` · ${d.pages} pages` : ""}</div></td>
                <td className="p-3">{d.collection}</td>
                <td className="p-3">
                  <span className={`rounded px-2 py-0.5 text-xs ${d.status === "READY" ? "bg-emerald-400/10 text-emerald-200" : d.status === "FAILED" ? "bg-rose-500/15 text-rose-200" : "bg-amber-400/10 text-amber-200"}`}>{d.status}</span>
                  {d.error && <div className="mt-1 max-w-xs text-xs text-rose-300">{d.error}</div>}
                </td>
                <td className="tabular p-3">v{d.version}{d.liveVersion && d.liveVersion !== d.version ? ` (live v${d.liveVersion})` : ""}</td>
                <td className="tabular p-3">{d.chunks}</td>
                <td className="whitespace-nowrap p-3 text-right">
                  <button type="button" disabled={pending === d.id} aria-label={`Re-index ${d.title}`} className="mr-3 text-violet-300 hover:text-violet-200 disabled:opacity-40" onClick={() => act(d, "reindex")}>Re-index</button>
                  <button type="button" disabled={pending === d.id} aria-label={`Delete ${d.title}`} className="text-rose-300 hover:text-rose-200 disabled:opacity-40" onClick={() => act(d, "delete")}>Delete</button>
                </td>
              </tr>
            ))}
            {!docs.length && <tr><td className="p-6 text-center text-faint" colSpan={6}>{loading ? "Loading…" : loadError ? "Couldn't load documents." : "No documents yet. Upload one above."}</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
