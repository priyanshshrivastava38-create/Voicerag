// Streaming LLM providers.
//  - ollama:    local models via Ollama's /api/chat (NDJSON stream). keep_alive keeps the model resident.
//  - anthropic: Claude via the official SDK (messages.stream).
//  - openai:    any OpenAI-compatible /chat/completions SSE endpoint (OpenAI, Groq, vLLM, …).
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { ensureOk, mapFetchError, readLines, sseData } from "./http";
import { type Health, type LlmEvent, type LlmProvider, type LlmRequest, ProviderError, idleTimeout } from "./types";

export class OllamaLlm implements LlmProvider {
  name = "ollama";
  locality = "local" as const;
  constructor(
    public model = env.llmModel,
    private url = env.ollamaUrl,
  ) {}

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    // Inactivity deadline (first token, then between chunks), not a cap on total answer length.
    const idle = idleTimeout(signal, env.llmTimeoutMs);
    const s = idle.signal;
    let res: Response;
    try {
      res = await ensureOk(
        this.name,
        await fetch(`${this.url}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            stream: true,
            keep_alive: "30m",
            messages: [{ role: "system", content: req.system }, ...req.messages],
            options: { temperature: req.temperature, num_predict: req.maxTokens, num_ctx: env.llmNumCtx },
          }),
          signal: s,
        }),
      );
    } catch (e) {
      idle.clear();
      mapFetchError(this.name, e, s);
    }
    try {
      for await (const line of readLines(res.body)) {
        idle.touch();
        const j = JSON.parse(line) as { message?: { content?: string }; done?: boolean; prompt_eval_count?: number; eval_count?: number; error?: string };
        if (j.error) throw new ProviderError(this.name, "BAD_RESPONSE", j.error);
        if (j.message?.content) yield { type: "token", text: j.message.content };
        if (j.done) {
          idle.clear();
          yield { type: "usage", inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0 };
        }
      }
    } catch (e) {
      idle.clear();
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {
    // Loads weights into memory and keeps them resident; no tokens generated.
    await fetch(`${this.url}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model: this.model, keep_alive: "30m", prompt: "" }),
      signal: AbortSignal.timeout(120_000),
    }).catch(() => undefined);
  }

  async health(): Promise<Health> {
    try {
      const r = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const j = (await r.json()) as { models?: { name: string }[] };
      const has = j.models?.some((m) => m.name === this.model || m.name === `${this.model}:latest`);
      return has ? { ok: true, detail: `${this.model} available` } : { ok: false, detail: `model ${this.model} not pulled (ollama pull ${this.model})` };
    } catch {
      return { ok: false, detail: `Ollama not reachable at ${this.url}` };
    }
  }
}

export class AnthropicLlm implements LlmProvider {
  name = "anthropic";
  locality = "cloud" as const;
  private client: Anthropic | null = null;
  constructor(public model = env.llmModel) {}

  private c() {
    if (!env.anthropicKey) throw new ProviderError(this.name, "AUTH", "ANTHROPIC_API_KEY is not configured");
    // One client per process: the SDK reuses its HTTP connection pool across requests.
    this.client ??= new Anthropic({ apiKey: env.anthropicKey, maxRetries: 1, timeout: env.llmTimeoutMs });
    return this.client;
  }

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    const client = this.c();
    // Inactivity deadline (first token, then between chunks), not a cap on total answer length.
    const idle = idleTimeout(signal, env.llmTimeoutMs);
    const s = idle.signal;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      // Low effort keeps time-to-first-token short for brief spoken answers; refusals fall back
      // server-side to another model instead of ending the turn silently.
      const stream = client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        } as Parameters<typeof client.beta.messages.stream>[0],
        { signal: s },
      );
      for await (const event of stream) {
        idle.touch();
        if (event.type === "message_start") inputTokens = event.message.usage.input_tokens;
        else if (event.type === "message_delta") outputTokens = event.usage.output_tokens;
        else if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "token", text: event.delta.text };
      }
      idle.clear();
      yield { type: "usage", inputTokens, outputTokens };
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new ProviderError(this.name, "RATE_LIMITED", e.message, true);
      if (e instanceof Anthropic.AuthenticationError) throw new ProviderError(this.name, "AUTH", e.message);
      if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) throw new ProviderError(this.name, "UNAVAILABLE", e.message, true);
      idle.clear();
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {}

  async health(): Promise<Health> {
    return env.anthropicKey ? { ok: true, detail: `${this.model} (key configured, not probed)` } : { ok: false, detail: "ANTHROPIC_API_KEY missing" };
  }
}

export class OpenAiCompatibleLlm implements LlmProvider {
  locality = "cloud" as const;
  constructor(
    public model = env.llmModel,
    private baseUrl = env.openaiBaseUrl,
    private apiKey = env.openaiKey,
    public name = "openai",
  ) {}

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    if (!this.apiKey) throw new ProviderError(this.name, "AUTH", "API key is not configured");
    // Inactivity deadline (first token, then between chunks), not a cap on total answer length.
    const idle = idleTimeout(signal, env.llmTimeoutMs);
    const s = idle.signal;
    let res: Response;
    try {
      res = await ensureOk(
        this.name,
        await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: req.maxTokens,
            temperature: req.temperature,
            ...(env.llmReasoningEffort ? { reasoning_effort: env.llmReasoningEffort } : {}),
            messages: [{ role: "system", content: req.system }, ...req.messages],
          }),
          signal: s,
        }),
      );
    } catch (e) {
      idle.clear();
      mapFetchError(this.name, e, s);
    }
    try {
      for await (const d of sseData(res.body)) {
        idle.touch();
        const j = JSON.parse(d) as { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
        const t = j.choices?.[0]?.delta?.content;
        if (t) yield { type: "token", text: t };
        if (j.usage) {
          idle.clear();
          yield { type: "usage", inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens };
        }
      }
    } catch (e) {
      idle.clear();
      mapFetchError(this.name, e, s);
    }
  }

  async warmup() {}

  async health(): Promise<Health> {
    if (!this.apiKey) return { ok: false, detail: `${this.name}: API key missing` };
    try {
      const r = await fetch(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { ok: false, detail: `${this.name}: HTTP ${r.status} listing models (check the key)` };
      const j = (await r.json()) as { data?: { id: string }[] };
      const ids = (j.data ?? []).map((m) => m.id.replace(/^models\//, ""));
      return ids.includes(this.model) ? { ok: true, detail: `${this.name}:${this.model}` } : { ok: false, detail: `${this.name}: model ${this.model} not available to this key` };
    } catch (e) {
      return { ok: false, detail: `${this.name}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
