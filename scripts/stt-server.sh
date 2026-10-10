#!/usr/bin/env bash
# Local whisper.cpp STT sidecar (127.0.0.1 only). Audio never leaves this host.
set -euo pipefail
[ -f .env ] && set -a && . ./.env && set +a
MODEL="${WHISPERCPP_MODEL_PATH:-$HOME/.cache/whisper/ggml-base.en.bin}"
MODEL="${MODEL/#\~/$HOME}"
PORT="$(echo "${WHISPERCPP_URL:-http://127.0.0.1:8178}" | sed -E 's#.*:([0-9]+).*#\1#')"
BIN="${WHISPER_SERVER_BIN:-}"
[ -z "$BIN" ] && [ -x .vendor/bin/whisper-server ] && BIN=.vendor/bin/whisper-server
[ -z "$BIN" ] && BIN="$(command -v whisper-server || true)"
[ -n "$BIN" ] || { echo "whisper-server not found. Build whisper.cpp (see docs/OPERATIONS.md) or set WHISPER_SERVER_BIN." >&2; exit 1; }
[ -f "$MODEL" ] || { echo "Model not found: $MODEL (see docs/OPERATIONS.md)" >&2; exit 1; }
# -nt: no timestamps; -bs 1/-bo 1: greedy decoding (fastest); threads = perf cores.
# -nc: NEVER condition on the previous request's text. The server is shared by all sessions, so
#      without it one user's transcript would bias (and leak into) the next user's decoding.
# -nf: no temperature-fallback re-decoding (bounded latency on noisy audio).
exec "$BIN" -m "$MODEL" --host 127.0.0.1 --port "$PORT" -t "${WHISPER_THREADS:-4}" -nt -nc -nf -bs 1 -bo 1 -l en
