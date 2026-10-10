# Security and privacy

## Data flows (default local configuration)

| Data | Where it goes | Stored? |
|---|---|---|
| Microphone audio | Browser → app server (WebSocket, only while speaking) → whisper.cpp on 127.0.0.1 | **No.** Held in memory for the current utterance only. Raw audio is never written to disk or the database. |
| Transcripts, answers, citations | App server → Postgres | Yes, as conversation history. Purged after `VOICERAG_RETENTION_DAYS` (default 30). |
| Retrieved text | Postgres → LLM (Ollama, 127.0.0.1) | Chunk text is stored. Prompts are not logged. |
| Answer text | App → Piper on 127.0.0.1 | No |
| Turn metrics | Postgres | Timings, counts and provider names only. No text. |
| Audit events | Postgres | Identifiers and small redacted details only. No transcripts, answers or document text. |

Switching any stage to a cloud provider (`*_PROVIDER=openai|anthropic`) sends that stage's data to the vendor.
The UI shows "includes third-party cloud providers" and the consent dialog names each provider.
**Do not enable cloud providers, or load real documents, until the organisation has approved the vendor's
retention, training-use and residency terms.** Audio goes to at most one STT provider; nothing fans out to several vendors.

## Controls implemented

| Area | Control | Where |
|---|---|---|
| Authentication | Random session token in an httpOnly, SameSite=Lax cookie (Secure in production); only SHA-256 stored; 12 h expiry; disabled users rejected | `src/lib/session.ts`, `src/lib/auth.ts` |
| Login | Constant-ish time for unknown users; per-IP rate limit; scrypt password hashes; failed logins audited | `src/server/users.ts` |
| Authorisation (RBAC) | `ADMIN` / `MEMBER`; document mutations and metrics are admin-only, enforced server-side | `requireAdmin`, routes |
| Permission-aware retrieval | Scope = collections granted to the user's groups, computed server-side per turn; enforced inside the SQL query and re-checked in code. Admin rights do not widen retrieval. | `src/server/access.ts`, `retrieve.ts` |
| Cache isolation | Retrieval cache key = index version + authorisation scope + k + query. No answers are cached. | `retrieve.ts` |
| IDOR | Chunks, documents and conversations are looked up with the caller's scope or ownership; returns 404, not 403 | `access.ts`, `/api/conversations/[id]` |
| CSRF | SameSite cookies plus an Origin check on mutating requests | `src/lib/api.ts` |
| WebSocket hijacking | Origin must match Host on upgrade; session cookie required; per-user session cap | `src/server/voice/upgrade.ts` |
| Input limits | Upload size, type by extension **and** magic bytes, UTF-8 check, page and character caps; WS frame cap 256 KB; utterance cap 30 s; text 1 000 chars | `validate.ts`, `extract.ts`, `session.ts` |
| Cost and abuse | Per-user turn rate limit, upload rate limit, bounded `max_tokens`, bounded timeouts, a single LLM retry | `session.ts`, `env.ts` |
| Prompt injection | Evidence fenced in unforgeable tags; documents declared untrusted; AI-directed sentences removed; system-prompt leak guard; no tools or actions available to the model; suspicious documents audited | `prompt.ts`, `turn.ts`, `ingest.ts` |
| Citations | Only markers that map to supplied passages are shown or spoken; the model cannot invent sources | `citations.ts`, UI |
| Secrets | Server-side environment only; never sent to the browser; redacted from logs | `env.ts`, `redact.ts` |
| Storage | Documents are content-addressed under `VOICERAG_STORAGE_DIR` (mode 0600, never served statically). Deletion erases files and scrubs citation excerpts. | `documents.ts` |
| STT isolation | whisper.cpp runs with `-nc`, so one user's transcript never conditions another's decoding | `scripts/stt-server.sh` |
| Microphone consent | An explicit consent dialog names the providers before the first capture; the mic is active only during a conversation; `Permissions-Policy: microphone=(self)` | `voice-console.tsx`, `next.config.ts` |
| Headers | nosniff, `X-Frame-Options: DENY`, `Referrer-Policy` | `next.config.ts` |
| Retention | `npm run retention:purge` (conversations, metrics, expired sessions; audit kept ≥ 1 year) | `scripts/retention-purge.ts` |

Verified by automated tests: permission leakage, cache isolation, IDOR, WebSocket origin and
authentication, injection, uploads by non-admins, and conversation hijack. HTTP checks were also run
against a live server: 401/403/404 responses, cross-origin POST rejected, and headers present.

## Required before production (not done)

- SSO (OIDC/SAML) and MFA instead of local passwords; group sync from the identity provider.
- TLS termination (HTTPS/WSS) at a reverse proxy, with HSTS. `getUserMedia` requires HTTPS outside localhost.
- Encryption at rest for Postgres and document storage (disk or KMS); managed secrets (Vault or a cloud secrets manager).
- A shared rate limiter and session cap (Redis) if more than one web node runs.
- A content security policy (CSP) tuned for Next.js.
- Malware scanning of uploads; OCR policy for scanned PDFs (currently rejected as having no text).
- A document approval workflow and an injection review queue (the audit event exists; there is no UI yet).
- Vendor review (DPA, retention, residency) for any cloud provider; a DPIA for voice processing.
- Penetration test and threat-model review.
