# syntax=docker/dockerfile:1.7
# whisper.cpp HTTP server (speech-to-text sidecar). Audio is decoded on this host and never leaves it.
# The app calls POST /inference (multipart audio) and GET / (reachability), see src/server/providers/stt.ts.
#
# Built by deploy/docker-compose.yml (context = repo root). Build args:
#   WHISPER_CPP_VERSION  whisper.cpp git tag (same as docs/OPERATIONS.md)
#   WHISPER_MODEL        ggml model name, e.g. base.en (default) or small.en (more accurate, ~3x slower)
#   WHISPER_MODEL_SHA256 sha256 of ggml-${WHISPER_MODEL}.bin; MUST be changed together with WHISPER_MODEL
#                        (small.en: c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d)
#   GGML_NATIVE          ON = optimise for the CPU of the machine that builds the image (build on the VM).
#                        Set OFF if the image is built on one machine and run on a different CPU.

ARG WHISPER_CPP_VERSION=v1.8.2
ARG WHISPER_MODEL=base.en
ARG WHISPER_MODEL_SHA256=a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002

# ---- build the server binary ------------------------------------------------------------------
FROM debian:bookworm-slim AS build
ARG WHISPER_CPP_VERSION
ARG GGML_NATIVE=ON
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
# On arm64, -march=native misdetects CPU features inside Docker's VM (Apple Silicon) and the build
# fails on dot-product intrinsics, so target ARMv8.2 + dotprod explicitly (Graviton 2+, Ampere,
# Apple M-series). x86-64 builds keep GGML_NATIVE (optimise for the VM that builds the image).
RUN if [ "${TARGETARCH}" = "arm64" ]; then ARCH_FLAGS="-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod"; \
    else ARCH_FLAGS="-DGGML_NATIVE=${GGML_NATIVE}"; fi \
 && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF ${ARCH_FLAGS} \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build build -j"$(nproc)" --target whisper-server \
 && strip build/bin/whisper-server

# ---- download and verify the model ----------------------------------------------------------
FROM debian:bookworm-slim AS model
ARG WHISPER_MODEL
ARG WHISPER_MODEL_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir /models \
 && curl -fsSL --retry 3 -o "/models/ggml-${WHISPER_MODEL}.bin" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin" \
 && echo "${WHISPER_MODEL_SHA256}  /models/ggml-${WHISPER_MODEL}.bin" | sha256sum -c -

# ---- runtime ----------------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
ARG WHISPER_MODEL
# libgomp1: OpenMP runtime used by ggml's CPU backend. curl: container healthcheck only.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin whisper
COPY --from=build /src/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=model /models /models
ENV WHISPER_MODEL=${WHISPER_MODEL} \
    WHISPER_THREADS=4 \
    WHISPER_HOST=0.0.0.0
USER whisper
EXPOSE 8178
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:8178/ || exit 1
# Same flags as scripts/stt-server.sh, but listening on all container interfaces (the port is only
# reachable on the internal compose network; it is never published to the host). Set WHISPER_HOST=::
# where the private network is IPv6 (Railway, see docs/DEPLOY-VERCEL.md).
#   -nt no timestamps; -bs 1 / -bo 1 greedy decoding; -nf no temperature fallback (bounded latency);
#   -nc NEVER condition on the previous request's text: the server is shared by all users, so without
#       it one user's transcript would bias (and leak into) the next user's decoding.
CMD ["sh", "-c", "exec whisper-server -m /models/ggml-${WHISPER_MODEL}.bin --host ${WHISPER_HOST} --port 8178 -t ${WHISPER_THREADS} -nt -nc -nf -bs 1 -bo 1 -l en"]
