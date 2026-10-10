"use client";
import { useCallback, useEffect, useState } from "react";

interface Collection { id: string; name: string; slug: string; documents: number; groups?: string[]; searchable: boolean }
interface Doc { id: string; title: string; filename: string; collection: string; collectionId: string; status: string; error: string | null; version: number; liveVersion: number | null; chunks: number; pages: number | null; updatedAt: string }

export function DocumentsAdmin() {
  const [cols, setCols] = useState<Collection[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [collectionId, setCollectionId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  const load = useCallback(async () => {
    const [c, d] = await Promise.all([fetch("/api/collections").then((r) => r.json()), fetch("/api/documents").then((r) => r.json())]);
    setCols(c.collections ?? []);
    setDocs(d.documents ?? []);
    setCollectionId((x) => x || c.collections?.[0]?.id || "");
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

  async function upload(e: React.FormEvent, documentId?: string) {
    e.preventDefault();
    if (!file || !collectionId) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("collectionId", collectionId);
    if (documentId) fd.set("documentId", documentId);
    const r = await fetch("/api/documents", { method: "POST", body: fd });
    const j = await r.json();
    setBusy(false);
    setMsg(r.ok ? (j.duplicate ? "Identical content is already indexed — nothing to do." : "Uploaded. Indexing in the background…") : j.error?.message ?? "Upload failed.");
    setFile(null);
    setInputKey((k) => k + 1); // remount the file input to clear it
    void load();
  }

  async function act(id: string, action: "reindex" | "delete") {
    if (action === "delete" && !confirm("Delete this document? It is removed from search immediately and its stored file is erased.")) return;
    const r = await fetch(action === "delete" ? `/api/documents/${id}` : `/api/documents/${id}/reindex`, { method: action === "delete" ? "DELETE" : "POST" });
    if (!r.ok) setMsg((await r.json()).error?.message ?? "Action failed.");
    void load();
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
            <select className="input mt-1.5 !w-auto min-w-48" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-white/65">File</span>
            <input key={inputKey} id="file" type="file" accept=".pdf,.docx,.txt,.md,.markdown" className="mt-1.5 block text-sm text-white/60 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-white/15" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button disabled={!file || busy} className="btn btn-primary h-10 px-4">{busy ? "Uploading…" : "Upload"}</button>
        </form>
        {msg && <p className="mt-3 text-sm text-white/80" role="status">{msg}</p>}
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
                  <button className="mr-3 text-violet-300 hover:text-violet-200" onClick={() => act(d.id, "reindex")}>Re-index</button>
                  <button className="text-rose-300 hover:text-rose-200" onClick={() => act(d.id, "delete")}>Delete</button>
                </td>
              </tr>
            ))}
            {!docs.length && <tr><td className="p-6 text-center text-faint" colSpan={6}>No documents yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
