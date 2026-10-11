import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
// Split hosting (docs/DEPLOY-VERCEL.md): the voice WebSocket lives on another origin.
const voiceWs = (process.env.NEXT_PUBLIC_VOICE_WS_URL ?? "").trim().replace(/\/$/, "");

// Everything is same-origin (except a split-hosted voice server): the voice WebSocket, the audio worklet and the self-hosted fonts.
// Next.js injects inline bootstrap scripts, hence 'unsafe-inline' (a nonce-based CSP via middleware
// is the stricter follow-up); dev mode additionally needs eval for fast refresh.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  `connect-src 'self'${voiceWs ? ` ${voiceWs}` : ""}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  serverExternalPackages: ["@prisma/client", "unpdf", "mammoth"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          // Microphone only for this origin; nothing else may use it.
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
          // Browsers honour HSTS only over HTTPS, so this is inert on plain-http localhost.
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
