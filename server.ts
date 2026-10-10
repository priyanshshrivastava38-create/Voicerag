// VIH VoiceRAG server: Next.js (UI + REST API) and the voice WebSocket on one port.
//
//   npm run dev    → development (hot reload)
//   npm start      → production (after `npm run build`)
//
// The WebSocket upgrade is authenticated with the same session cookie as the REST API and is
// origin-checked (cross-site WebSocket hijacking defence).
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
// Next.js expects this global before any of its server modules load (its own CLI sets it).
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

async function main() {
  // Imported after .env is loaded so module-level config reads see it.
  const { env } = await import("./src/lib/env");
  const { authorizeUpgrade } = await import("./src/server/voice/upgrade");
  const { providers, describeProviders, warmProviders } = await import("./src/server/providers/registry");
  const { VoiceSession } = await import("./src/server/voice/session");
  const { startWorker } = await import("./src/server/rag/ingest");
  const { WS_PATH } = await import("./src/shared/protocol");
  const { setReady } = await import("./src/server/health");

  const dev = !env.isProduction;
  const app = next({ dev, hostname: "localhost", port: env.port });
  const handle = app.getRequestHandler();
  await app.prepare();
  const nextUpgrade = app.getUpgradeHandler();

  const p = providers(); // fails fast on bad provider config (and on mocks in production)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) return nextUpgrade(req, socket, head); // Next dev HMR etc.
    const query = Object.fromEntries(url.searchParams);
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const d = await authorizeUpgrade(req, query);
      if (!d.ok) return reject(d.status, d.reason);
      wss.handleUpgrade(req, socket, head, (ws) => new VoiceSession(ws, d.user, p, { source: d.source }).start());
    } catch {
      reject(500, "Internal Server Error");
    }
  });

  const stopWorker = env.inprocessWorker ? startWorker() : () => undefined;

  server.listen(env.port, () => {
    console.log(`> VIH VoiceRAG on http://localhost:${env.port} (${dev ? "development" : "production"})`);
    console.log(`> providers: ${JSON.stringify(describeProviders(p))}`);
  });

  // Warm models in the background; readiness flips when done (see /api/ready).
  warmProviders(p).then((ms) => {
    setReady(true, ms);
    console.log(`> providers warm in ${ms} ms`);
  });

  const shutdown = () => {
    console.log("> shutting down");
    setReady(false, null);
    stopWorker();
    for (const c of wss.clients) c.close(1001, "server shutdown");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
