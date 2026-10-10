#!/usr/bin/env bash
# Local Piper TTS sidecar (127.0.0.1 only). Text never leaves this host.
set -euo pipefail
[ -f .env ] && set -a && . ./.env && set +a
MODEL="${PIPER_MODEL_PATH:-$HOME/.cache/piper/en_US-lessac-medium.onnx}"
MODEL="${MODEL/#\~/$HOME}"
PORT="$(echo "${PIPER_URL:-http://127.0.0.1:8179}" | sed -E 's#.*:([0-9]+).*#\1#')"
PY="${PIPER_PYTHON:-.venv-tts/bin/python}"
[ -x "$PY" ] || { echo "Create the venv first: python3 -m venv .venv-tts && .venv-tts/bin/pip install piper-tts" >&2; exit 1; }
[ -f "$MODEL" ] || { echo "Voice not found: $MODEL (see docs/OPERATIONS.md)" >&2; exit 1; }
exec "$PY" scripts/tts_server.py --model "$MODEL" --host 127.0.0.1 --port "$PORT"
