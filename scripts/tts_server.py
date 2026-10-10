#!/usr/bin/env python3
"""Piper TTS sidecar for VIH VoiceRAG.

Keeps the voice model warm in memory and streams raw PCM16 mono audio over HTTP so the Node
server can forward the first audio chunk as soon as Piper produces it.

  POST /synthesize   {"text": "...", "length_scale": 1.0}
      -> 200 application/octet-stream, chunked PCM16LE; header X-Sample-Rate
  GET  /health       -> {"ok": true, "voice": "...", "sample_rate": 22050}

Binds to 127.0.0.1 only. Text is never logged.
"""
import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from piper import PiperVoice, SynthesisConfig

MAX_CHARS = 2000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8179)
    args = ap.parse_args()

    voice = PiperVoice.load(args.model)
    sample_rate = voice.config.sample_rate
    # onnxruntime sessions are thread-safe for run(), but serialising keeps CPU contention
    # predictable on small hosts; concurrent requests queue (measured by the load benchmark).
    lock = threading.Lock()
    # Warm the graph so the first real request is not a cold start.
    for _ in voice.synthesize("Ready."):
        pass

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *a):  # no request logging (text privacy)
            pass

        def _json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._json(200, {"ok": True, "voice": args.model.rsplit("/", 1)[-1], "sample_rate": sample_rate})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/synthesize":
                return self._json(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n <= 0 or n > 16384:
                    return self._json(413, {"error": "bad length"})
                req = json.loads(self.rfile.read(n))
                text = str(req.get("text", ""))[:MAX_CHARS].strip()
                scale = float(req.get("length_scale", 1.0))
                scale = min(2.0, max(0.5, scale))
            except Exception:
                return self._json(400, {"error": "bad request"})
            if not text:
                return self._json(400, {"error": "empty text"})

            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("X-Sample-Rate", str(sample_rate))
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                with lock:
                    for chunk in voice.synthesize(text, syn_config=SynthesisConfig(length_scale=scale)):
                        data = chunk.audio_int16_bytes
                        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
                        self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # client cancelled (barge-in): stop synthesising

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"piper tts sidecar on http://{args.host}:{args.port} ({sample_rate} Hz)", file=sys.stderr, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
