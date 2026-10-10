// VIH VoiceRAG server: Next.js (UI + REST API) and the voice WebSocket on one port.
//
//   npm run dev    → development (hot reload)
//   npm start      → production (after `npm run build`)
//
// The WebSocket upgrade is authenticated with the same session cookie as the REST API and is
// origin-checked (cross-site WebSocket hijacking defence).
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import next from "next";
import { type WebSocket, WebSocketServer } from "ws";

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
  const { prisma } = await import("./src/lib/db");
  const { CLIENT_IP_HEADER } = await import("./src/lib/api");
  const { redactString } = await import("./src/lib/redact");

  // Crash visibility: log, then exit so the supervisor restarts a clean process.
  process.on("unhandledRejection", (e) => console.error("[fatal] unhandled rejection:", redactString(String(e instanceof Error ? (e.stack ?? e) : e))));
  process.on("uncaughtException", (e) => {
    console.error("[fatal] uncaught exception:", redactString(String(e.stack ?? e)));
    if (shutdownHook) void shutdownHook(1);
    else process.exit(1);
  });

  // Fail fast with an actionable message instead of erroring on the first request.
  if (env.isProduction) {
    const placeholders = Object.entries(process.env).filter(([, v]) => v?.includes("CHANGE_ME")).map(([k]) => k);
    if (placeholders.length) throw new Error(`Replace the placeholder values in the production environment before starting: ${placeholders.sort().join(", ")}.`);
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and set it.");
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    throw new Error(`Cannot reach the database at DATABASE_URL (${redactString(e instanceof Error ? e.message.split("\n").pop() ?? "" : String(e))}). Is Postgres running and migrated (npm run db:deploy)?`);
  }

  // Only the TCP peer is trusted, unless TRUST_PROXY=true says a reverse proxy sets X-Forwarded-For
  // (then its right-most entry is the address the proxy saw).
  const trustProxy = process.env.TRUST_PROXY === "true";
  const clientIp = (req: IncomingMessage) => {
    const xff = req.headers["x-forwarded-for"];
    const forwarded = trustProxy && typeof xff === "string" ? xff.split(",").pop()?.trim() : undefined;
    return forwarded || req.socket.remoteAddress || "unknown";
  };

  const dev = !env.isProduction;
  const app = next({ dev, hostname: "localhost", port: env.port });
  const handle = app.getRequestHandler();
  await app.prepare();
  const nextUpgrade = app.getUpgradeHandler();

  const p = providers(); // fails fast on bad provider config (and on mocks in production)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

  const server = createServer((req, res) => {
    req.headers[CLIENT_IP_HEADER] = clientIp(req); // overwrites any client-supplied value
    void handle(req, res);
  });
  // Longer than typical proxy/load-balancer idle timeouts (60 s), avoiding intermittent 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Heartbeat: terminate half-open sockets so dead sessions don't count against the per-user cap.
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  let stopping = false;
  server.on("upgrade", async (req, socket, head) => {
    if (stopping) return socket.destroy();
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
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
        new VoiceSession(ws, d.user, p, { source: d.source }).start();
      });
    } catch (e) {
      console.error("[voice] upgrade failed:", redactString(String(e)));
      reject(500, "Internal Server Error");
    }
  });

  const stopWorker = env.inprocessWorker ? startWorker() : async () => undefined;

  server.listen(env.port, () => {
    console.log(`> VIH VoiceRAG on http://localhost:${env.port} (${dev ? "development" : "production"})`);
    console.log(`> providers: ${JSON.stringify(describeProviders(p))}`);
  });

  // Warm models in the background; readiness flips when done (see /api/ready).
  void warmProviders(p).then((ms) => {
    if (stopping) return;
    setReady(true, ms);
    console.log(`> providers warm in ${ms} ms`);
  });

  // Graceful shutdown: stop taking traffic, end voice sessions, let the in-flight ingestion job
  // finish, close HTTP, then release the database pool. A hard deadline guards against hangs.
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    console.log("> shutting down");
    setReady(false, null);
    setTimeout(() => process.exit(code || 1), 10_000).unref();
    clearInterval(heartbeat);
    for (const c of wss.clients) c.close(1001, "server shutdown");
    await stopWorker().catch(() => undefined);
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeIdleConnections();
    });
    await prisma.$disconnect().catch(() => undefined);
    process.exit(code);
  }
  shutdownHook = shutdown;
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

// Set once the server is up; before that, a fatal error simply exits.
let shutdownHook: ((code?: number) => Promise<void>) | null = null;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
