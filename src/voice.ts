// The neural voice Alexa+ speaks with in the simulator, when it is installed: Kokoro (Apache 2.0) behind scripts/tts-server.py on
// localhost. Hearth only ever talks to it on 127.0.0.1 (or the operator's HEARTH_TTS_URL), never sends household data to it other
// than the sentence to be spoken, and everything falls back to the browser's own voices when it is absent or fails.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SpeakLang = "en" | "es" | "hi";
export const SPEAK_LANGS: readonly SpeakLang[] = ["en", "es", "hi"];
export const MAX_SPEAK_CHARS = 600;

const PORT = Number(process.env.HEARTH_TTS_PORT ?? 8767);
const URL_BASE = process.env.HEARTH_TTS_URL ?? `http://127.0.0.1:${PORT}`;
const VOICES: Record<SpeakLang, { voice: string; lang: string }> = {
  en: { voice: process.env.HEARTH_TTS_VOICE ?? "af_heart", lang: "en-us" },
  es: { voice: "ef_dora", lang: "es" },
  hi: { voice: "hf_alpha", lang: "hi" },
};

/** Where the voice is installed (npm run tts:setup), or undefined when it is not there or switched off with HEARTH_TTS=off. */
export function ttsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HEARTH_TTS === "off") return undefined;
  const dir = env.HEARTH_TTS_DIR ?? join(homedir(), ".hearth-tts");
  return existsSync(join(dir, "venv", "bin", "python")) && existsSync(join(dir, "kokoro-v1.0.onnx")) && existsSync(join(dir, "voices-v1.0.bin")) ? dir : undefined;
}

let child: ChildProcess | undefined;
let ready = false;
export const voiceReady = () => ready;

const answers = () => fetch(URL_BASE, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

/** Start (or find) the voice in the background; the server never waits for it. */
export async function startVoice(root: string): Promise<void> {
  if (process.env.HEARTH_TTS === "off") return; // off means off: not even a voice server that is already running
  if (await answers()) { ready = true; return; } // someone already runs one (for example the demo recorder): use it, and never stop it
  const dir = process.env.HEARTH_TTS_URL ? undefined : ttsDir();
  if (!dir) return;
  child = spawn(join(dir, "venv", "bin", "python"), [join(root, "scripts", "tts-server.py"), "--model", join(dir, "kokoro-v1.0.onnx"), "--voices", join(dir, "voices-v1.0.bin"), "--port", String(PORT)], { cwd: dir, stdio: "ignore" });
  child.on("exit", () => { ready = false; child = undefined; });
  for (let i = 0; i < 90 && child; i++) { // the model takes a few seconds to load
    if (await answers()) { ready = true; console.log(JSON.stringify({ level: "info", msg: "neural voice ready", voice: VOICES.en.voice })); return; }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
export function stopVoice() { child?.kill(); child = undefined; ready = false; }

const cache = new Map<string, Buffer>(); // the same short sentences are spoken again and again; keep the last 150
let inflight = 0;

/** WAV audio for one short text, or null if the voice is unavailable, busy, or failed (the page then uses the browser's voice). */
export async function synthesize(text: string, lang: SpeakLang): Promise<Buffer | null> {
  if (!ready) return null;
  const key = `${lang}|${text}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  if (inflight >= 4) return null; // the voice speaks one sentence at a time; do not let a queue build behind it
  inflight++;
  try {
    const v = VOICES[lang];
    const r = await fetch(URL_BASE, { method: "POST", body: JSON.stringify({ text, voice: v.voice, speed: 1.0, lang: v.lang }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const wav = Buffer.from(await r.arrayBuffer());
    cache.set(key, wav);
    if (cache.size > 150) cache.delete(cache.keys().next().value as string);
    return wav;
  } catch { return null; } finally { inflight--; }
}
