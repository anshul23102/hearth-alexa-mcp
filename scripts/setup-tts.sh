#!/usr/bin/env bash
# One-time setup of the neural voice (Kokoro, Apache 2.0) Hearth speaks with when it is present. Nothing leaves the machine.
#   npm run tts:setup            installs into ~/.hearth-tts  (override with HEARTH_TTS_DIR)
# Needs Python 3.10+, curl, and espeak-ng for pronunciation:  brew install espeak-ng   or   sudo apt install espeak-ng
# Downloads ~340 MB: the kokoro-onnx package from PyPI, and kokoro-v1.0.onnx + voices-v1.0.bin from github.com/thewh1teagle/kokoro-onnx.
set -euo pipefail
DIR="${HEARTH_TTS_DIR:-$HOME/.hearth-tts}"
PY="${PYTHON:-python3}"
REL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
mkdir -p "$DIR"
[ -x "$DIR/venv/bin/python" ] || "$PY" -m venv "$DIR/venv"
"$DIR/venv/bin/pip" install -q --upgrade kokoro-onnx soundfile
[ -s "$DIR/kokoro-v1.0.onnx" ] || curl -L --fail -o "$DIR/kokoro-v1.0.onnx" "$REL/kokoro-v1.0.onnx"
[ -s "$DIR/voices-v1.0.bin" ] || curl -L --fail -o "$DIR/voices-v1.0.bin" "$REL/voices-v1.0.bin"
echo "Neural voice ready in $DIR. Start Hearth as usual (npm start); it finds the voice and uses it."
