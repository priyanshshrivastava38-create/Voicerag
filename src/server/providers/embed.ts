// Embedding providers. Vectors are L2-normalised so cosine distance in pgvector is meaningful.
import { env } from "@/lib/env";
import { ensureOk, mapFetchError } from "./http";
import { type EmbedProvider, type Health, ProviderError, l2normalize, withTimeout } from "./types";

const EMBED_TIMEOUT_MS = 30_000;

/** nomic-embed-text is asymmetric: it expects task prefixes on queries vs documents. */
function prefixFor(model: string, kind: "query" | "document") {
  if (model.startsWith("nomic-embed")) return kind === "query" ? "search_query: " : "search_document: ";
  return "";
}

export class OllamaEmbed implements EmbedProvider {
  name = "ollama";
  locality = "local" as const;
  constructor(
    public model = env.embedModel,
    public dim = env.embedDim,
    private url = env.ollamaUrl,
  ) {}

  async embed(texts: string[], kind: "query" | "document", signal: AbortSignal = new AbortController().signal) {
    const s = withTimeout(signal, EMBED_TIMEOUT_MS);
    const p = prefixFor(this.model, kind);
    try {
      const res = await ensureOk(
        this.name,
        await fetch(`${this.url}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, input: texts.map((t) => p + t), keep_alive: "30m" }),
          signal: s,
        }),
      );
      const j = (await res.json()) as { embeddings?: number[][] };
      if (!j.embeddings || j.embeddings.length !== texts.length) throw new ProviderError(this.name, "BAD_RESPONSE", "embedding count mismatch");
      if (j.embeddings[0]?.length !== this.dim) throw new ProviderError(this.name, "BAD_RESPONSE", `expected ${this.dim} dims, got ${j.embeddings[0]?.length}`);
      return j.embeddings.map(l2normalize);
    } catch (e) {
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {
    await this.embed(["warmup"], "query").catch(() => undefined);
  }

  async health(): Promise<Health> {
    try {
      await this.embed(["ok"], "query", AbortSignal.timeout(5000));
      return { ok: true, detail: `${this.model} (${this.dim}d)` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

export class OpenAiCompatibleEmbed implements EmbedProvider {
  name = "openai-embed";
  locality = "cloud" as const;
  constructor(
    public model = env.embedModel,
    public dim = env.embedDim,
    private baseUrl = env.openaiBaseUrl,
    private apiKey = env.openaiKey,
  ) {}

  async embed(texts: string[], _kind: "query" | "document", signal: AbortSignal = new AbortController().signal) {
    if (!this.apiKey) throw new ProviderError(this.name, "AUTH", "OPENAI_API_KEY is not configured");
    const s = withTimeout(signal, EMBED_TIMEOUT_MS);
    try {
      const res = await ensureOk(
        this.name,
        await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dim }),
          signal: s,
        }),
      );
      const j = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return j.data.sort((a, b) => a.index - b.index).map((d) => l2normalize(d.embedding));
    } catch (e) {
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {}

  async health(): Promise<Health> {
    return this.apiKey ? { ok: true, detail: `${this.baseUrl} (not probed)` } : { ok: false, detail: "OPENAI_API_KEY missing" };
  }
}
