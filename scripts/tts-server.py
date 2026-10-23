"""A tiny local text-to-speech server for the demo recorder, using the open-source Kokoro model (Apache 2.0).
Run with the Python from a venv that has `kokoro-onnx` and `soundfile` installed:
  python scripts/tts-server.py --model kokoro-v1.0.onnx --voices voices-v1.0.bin --port 8767
POST /speak {"text": ..., "voice": "af_heart", "speed": 1.0, "lang": "en-us"}  ->  audio/wav. Listens on 127.0.0.1 only."""
import argparse, io, json
from http.server import BaseHTTPRequestHandler, HTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro
from kokoro_onnx.config import EspeakConfig

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--voices", required=True)
ap.add_argument("--port", type=int, default=8767)
# The espeak-ng library bundled in the pip wheel looks for its data in the build machine's path on some Macs; `brew install espeak-ng` fixes it.
ap.add_argument("--espeak-lib", default="/opt/homebrew/lib/libespeak-ng.dylib")
ap.add_argument("--espeak-data", default="/opt/homebrew/share/espeak-ng-data")
args = ap.parse_args()
kokoro = Kokoro(args.model, args.voices, espeak_config=EspeakConfig(lib_path=args.espeak_lib, data_path=args.espeak_data))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # readiness probe
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        samples, rate = kokoro.create(body["text"], voice=body.get("voice", "af_heart"), speed=float(body.get("speed", 1.0)), lang=body.get("lang", "en-us"))
        buf = io.BytesIO(); sf.write(buf, samples, rate, format="WAV")
        self.send_response(200); self.send_header("content-type", "audio/wav"); self.end_headers(); self.wfile.write(buf.getvalue())

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
