# syntax=docker/dockerfile:1.7
# Piper text-to-speech sidecar (scripts/tts_server.py). Text is synthesised on this host and never leaves it.
# The app calls POST /synthesize (streamed PCM16) and GET /health, see src/server/providers/tts.ts.
# Built by deploy/docker-compose.yml (context = repo root).

# ---- dependencies in an isolated virtualenv -----------------------------------------------------
FROM python:3.12.14-slim-bookworm AS build
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir piper-tts==1.8.0 onnxruntime==1.30.0

# ---- voice model (en_US-lessac-medium), checksum-verified -------------------------------------
FROM scratch AS voice
ADD --chmod=0444 --checksum=sha256:5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx \
    /models/en_US-lessac-medium.onnx
ADD --chmod=0444 --checksum=sha256:efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0 \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json \
    /models/en_US-lessac-medium.onnx.json

# ---- runtime ----------------------------------------------------------------------------------
FROM python:3.12.14-slim-bookworm AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin piper
COPY --from=build /opt/venv /opt/venv
COPY --from=voice /models /models
# Create /app first (0755): COPY --chmod would otherwise also apply 0444 to the directory it creates,
# which the non-root user then cannot enter.
WORKDIR /app
COPY --chmod=0444 scripts/tts_server.py /app/tts_server.py
USER piper
EXPOSE 8179
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8179/health', timeout=3)" || exit 1
# Listens on all container interfaces; the port is only reachable on the internal compose network.
CMD ["python", "/app/tts_server.py", "--model", "/models/en_US-lessac-medium.onnx", "--host", "0.0.0.0", "--port", "8179"]
