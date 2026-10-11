# Deploying VIH VoiceRAG on a single VM (Docker Compose)

This runbook takes a fresh Ubuntu 22.04 or 24.04 VM to a working HTTPS deployment. Follow the steps in order.
Every command runs on the VM, as a normal user with `sudo`, unless the step says otherwise.

```
 browser ──HTTPS/WSS──▶ caddy (:80/:443, Let's Encrypt) ──▶ app (:3100, Next.js + /ws/voice + ingestion worker)
                                                              │        │         │         │
                                                              db     ollama     stt       tts
                                                         Postgres16 (embeddings) whisper.cpp Piper
                                                         +pgvector  nomic-embed  base.en   lessac-medium
 app ──HTTPS──▶ Gemini API (LLM: questions + retrieved passages)
```

Only Caddy publishes ports. Postgres, Ollama, whisper.cpp and Piper are not reachable from outside the VM.
Audio (STT) and spoken text (TTS) are processed on the VM. The `db`, `stt` and `tts` containers have no
internet access. The app sends questions and retrieved document passages to Google's Gemini API.

> **Before loading real documents:** the launch uses synthetic demo documents. Sending real company
> documents to Gemini (a third-party hosted service) needs written approval from your organisation
> (security / privacy / data-protection review). Until then, load only the demo documents.

Files: `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/stt.Dockerfile`, `deploy/tts.Dockerfile`,
`deploy/backup.sh`, `Dockerfile` (app image), `.env.production.example`.

---

## 1. Size the VM

| | Minimum (pilot, a few concurrent speakers) | Recommended |
|---|---|---|
| CPU | 4 vCPU (x86-64 with AVX2) | 8 vCPU |
| RAM | 8 GB | 16 GB |
| Disk | 40 GB SSD | 80 GB SSD (backups, logs, images) |

- Speech-to-text runs on the CPU. With whisper `base.en` and 4 threads, a 3–5 s utterance typically takes
  about 0.5–1.5 s to transcribe on a modern x86 vCPU. This is an estimate: measure on your VM (step 12).
  Requests are processed one at a time, so latency rises when several people speak at once.
  `small.en` is more accurate but about 3× slower. Use it only on 8+ dedicated cores.
- Images and models take about 10 GB: app ~1.5 GB, Ollama ~3–4 GB, whisper + model ~0.3 GB, Piper ~0.5 GB, embedding model ~0.3 GB.
- No GPU is needed: the LLM is Gemini, and embeddings run on the CPU.

## 2. DNS

Create a DNS **A record** (and an AAAA record if the VM has IPv6) for your hostname, e.g. `voice.example.com`,
pointing to the VM's public IP. Check it from your laptop: `dig +short voice.example.com`.
Caddy cannot get a certificate until this record resolves to the VM and port 80 is reachable.

## 3. Firewall

Allow only SSH, HTTP (needed for the ACME challenge and the HTTPS redirect) and HTTPS:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp      # HTTP/3 (optional)
sudo ufw enable
```

If your cloud provider has its own firewall or security group, apply the same rules there.
Docker bypasses ufw for published ports. This is safe here because only Caddy publishes ports (80/443).
Never add `ports:` to the other services.

## 4. Install Docker

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"     # then log out and back in
docker compose version               # needs v2.24 or newer
```

## 5. Get the code

```bash
sudo mkdir -p /opt/vih-voicerag && sudo chown "$USER" /opt/vih-voicerag
git clone <your-repo-url> /opt/vih-voicerag
cd /opt/vih-voicerag
git checkout <release-tag-or-commit>     # deploy a known version, not a moving branch
```

Every later command runs from `/opt/vih-voicerag`. To keep them short, define this alias and add it to `~/.bashrc`:

```bash
alias dc='docker compose -f /opt/vih-voicerag/deploy/docker-compose.yml --env-file /opt/vih-voicerag/.env.production'
```

## 6. Create `.env.production`

```bash
cp .env.production.example .env.production
chmod 600 .env.production
openssl rand -hex 32      # use the output as POSTGRES_PASSWORD
nano .env.production
```

Change every line marked `# CHANGE ME`:

| Variable | Value |
|---|---|
| `DOMAIN` | The hostname from step 2, e.g. `voice.example.com` |
| `ACME_EMAIL` | An address that receives Let's Encrypt notices |
| `POSTGRES_PASSWORD` | The `openssl rand -hex 32` output (hex only: it is embedded in `DATABASE_URL`) |
| `GEMINI_API_KEY` | A key from https://aistudio.google.com/apikey |

Leave the other values as they are. `DATABASE_URL` is built from the `POSTGRES_*` values.
`LLM_FALLBACK_MODEL` is empty on purpose: if the Gemini key is missing or wrong, answers fail visibly.
The app does not quietly switch to a weak local model.
Do **not** add `VOICERAG_SEED_PASSWORD`; it is only for development seed users.
Never commit `.env.production`. Add it to `.gitignore` if it is not already listed.

Never change `POSTGRES_PASSWORD` after the first start: Postgres stores the password in its volume when it initialises.
To change it later, run `ALTER USER` inside the database as well.

## 7. Build the images

```bash
dc build
```

The first build takes 10–20 minutes. It compiles whisper.cpp v1.8.2 for this VM's CPU, downloads the
whisper `base.en` and Piper `en_US-lessac-medium` models (checksums verified), and builds the Next.js app.
If you build the images on one machine and run them on another, build with `--build-arg GGML_NATIVE=OFF`
for the stt service.

## 8. Start the database and apply migrations

```bash
dc up -d db
dc run --rm migrate          # prisma migrate deploy
```

## 9. Pull the embedding model

```bash
dc up -d ollama
dc run --rm ollama-pull      # downloads nomic-embed-text (~275 MB) into the ollama-models volume
```

## 10. Create the first admin and load the demo documents

```bash
dc run --rm app npm run admin:create -- --email admin@yourcompany.com --name "First Admin"
dc run --rm app npm run db:seed -- --docs-only
```

Follow `admin:create`'s output for the initial password. Run `dc run --rm app npm run admin:create -- --help` for its options.
`--docs-only` loads only the synthetic demo documents; it does not create the development seed users.
These commands also start `stt` and `tts`, because the app container waits for its dependencies.
The documents are embedded by the ingestion worker inside the app. They become searchable a minute or so after step 11.

## 11. Start everything

```bash
dc up -d
dc ps            # every service should show "running", and later "healthy"
```

## 12. Verify

```bash
curl -fsS https://voice.example.com/api/health      # liveness: {"ok":true}
curl -fsS https://voice.example.com/api/ready       # readiness: {"ready":true}  (HTTP 503 = not ready)
curl -sI http://voice.example.com | head -1         # should redirect (308) to https
```

Then, in a browser:

1. Open `https://voice.example.com` and sign in as the admin.
2. Open `/admin/documents` and check that the demo documents reach `READY`.
3. While signed in as an admin, `/api/ready` shows the detail for each provider.
4. Open the voice console, allow the microphone and ask a question about a demo document.
   Browsers allow the microphone **only over HTTPS** (or `localhost`), so voice cannot be tested via the VM's IP address over plain HTTP.
5. Check latency on `/admin/metrics` after a few turns.

## 13. Schedule retention and backups (cron)

Create the backup directory, then edit the crontab of the deploy user (who must be in the `docker` group):

```bash
sudo mkdir -p /var/backups/vih-voicerag && sudo chown "$USER" /var/backups/vih-voicerag
crontab -e
```

```cron
# Purge conversations/metrics older than VOICERAG_RETENTION_DAYS (daily 02:30)
30 2 * * * cd /opt/vih-voicerag && docker compose -f deploy/docker-compose.yml --env-file .env.production run --rm -T app npm run retention:purge >> $HOME/voicerag-retention.log 2>&1
# Database + document backup, keep 14 days (daily 03:15)
15 3 * * * RETENTION_DAYS=14 /opt/vih-voicerag/deploy/backup.sh >> $HOME/voicerag-backup.log 2>&1
```

Test both once by hand (`npm run retention:purge -- --dry-run` shows counts without deleting).
Copy `/var/backups/vih-voicerag` off the VM regularly, for example with rclone to object storage or with provider disk snapshots.

## Backups and restore

`deploy/backup.sh` writes `/var/backups/vih-voicerag/<date>/` containing `db.dump` (pg_dump custom format),
`storage.tar.gz` (the uploaded documents) and `SHA256SUMS`. Backups older than `RETENTION_DAYS` are deleted.
Override the location and retention with `BACKUP_DIR=... RETENTION_DAYS=...`.

Restore (overwrites the current data):

```bash
B=/var/backups/vih-voicerag/2026-01-31_031500
(cd "$B" && sha256sum -c SHA256SUMS)
dc stop app caddy
dc up -d db
dc exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$B/db.dump"
dc run --rm --no-deps -T app sh -c 'find /app/storage -mindepth 1 -delete && tar -xzf - -C /app/storage' < "$B/storage.tar.gz"
dc run --rm migrate        # only needed if the code is newer than the backup
dc up -d
```

Test a restore on a scratch VM at least monthly. Embeddings are stored in Postgres. They can also be rebuilt
from the documents with `dc run --rm app ./node_modules/.bin/tsx scripts/reindex-all.ts`.

## Upgrades

```bash
cd /opt/vih-voicerag
deploy/backup.sh                         # always back up first
git fetch && git checkout <new-tag>
dc build
dc run --rm migrate
dc up -d                                 # recreates only containers whose image/config changed
dc ps && curl -fsS https://$DOMAIN/api/ready
```

The app shuts down gracefully on SIGTERM: open voice sessions are closed and in-flight ingestion is finished.
Expect a few seconds of downtime; active callers must reconnect.
If `.env.example` changed in the new version, compare it with `.env.production.example` and update `.env.production`.

## Rollback

```bash
git checkout <previous-tag>
dc build && dc up -d
```

Prisma migrations only move forward. If the release you are rolling back from applied a migration that the
old code cannot handle, restore the database from the backup taken just before the upgrade (see Restore).

## Logs

```bash
dc logs -f app                 # application (secrets are redacted)
dc logs --since 1h stt tts ollama
dc logs -f caddy               # access log (JSON) and certificate issuance
```

Log files are rotated by Docker: 5 × 10 MB per container.

## Troubleshooting

| Symptom | Check |
|---|---|
| Browser shows a certificate error, or Caddy logs `challenge failed` | The DNS A record does not point to the VM, or port 80/443 is blocked (ufw or the cloud firewall). Fix it, then run `dc restart caddy`. Repeated failures are rate-limited by Let's Encrypt, so wait before retrying. |
| `dc` errors with `Set POSTGRES_PASSWORD ...` / `Set DOMAIN ...` | `--env-file .env.production` is missing, or the variable is empty. Use the `dc` alias. |
| app keeps restarting, logs say `Cannot reach the database` | `dc ps db` (is it healthy?); `DATABASE_URL` must use host `db`. Was `POSTGRES_PASSWORD` changed after the first start? (See step 6.) |
| app logs `relation ... does not exist` | Migrations were not applied. Run `dc run --rm migrate`. |
| `/api/ready` returns 503 | Sign in as admin and open `/api/ready`; the `providers` block names the failing stage. Then check `dc ps` and `dc logs stt tts ollama`. |
| Embedding errors, or documents stuck in QUEUED/FAILED | `dc run --rm ollama-pull` (was the model pulled?); `dc logs ollama`. Stale locks are reclaimed after 10 min. |
| App exits at start: "Replace the placeholder values…" or "API key is not set" | A `CHANGE_ME` value or the Gemini key is still missing in `.env.production`. Fix it, then `dc up -d app` (the app reads env only at start). |
| Every answer fails or says the LLM is unavailable | `GEMINI_API_KEY` is invalid or outbound HTTPS is blocked. Check `dc logs app` and `/api/ready`. |
| Microphone button does nothing or permission is denied | Use `https://`, not the IP address. Check the browser's site permissions. |
| Voice connects then drops immediately | `dc logs app` for `[voice]` lines. Open the site at exactly `https://$DOMAIN`: the WebSocket Origin must match the Host. |
| Slow transcripts | Raise `WHISPER_THREADS` (up to the number of physical cores), give the VM more vCPUs, or keep `base.en`. Compare the STT timings on `/admin/metrics`. |
| Login rate limiting blocks everyone at once | `TRUST_PROXY=true` must be set, otherwise every user appears to come from Caddy's IP. |
| A container is killed (`OOMKilled` in `docker inspect`) | Raise its `deploy.resources.limits.memory` in `deploy/docker-compose.yml`, or use a bigger VM. |
| Disk filling up | `docker system df`; `docker image prune` after upgrades; check the size of `/var/backups/vih-voicerag`. |
