// Spoken replies. The browser exposes whatever voices the operating system has; the default is often the most robotic one.
// This ranks what is installed so the warmest, most natural voice for the language is used, speaks sentence by sentence
// (long utterances get cut off in some browsers), and always resolves, so a conversation can never hang on a missing event.
// Amazon's own Alexa voice is not available to third-party apps, so this is deliberately "a pleasant assistant voice".

const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|fred|good news|jester|junior|organ|ralph|trinoids|whisper|wobble|superstar|zarvox|hysterical|deranged|pipe organ|bruce|vicki|agnes|kathy)\b/i;
const MALE = /^(alex|daniel|rishi|ralph|albert|grandpa|rocko|eddy|reed|jorge|diego|juan|carlos|evan|aaron|arthur|oliver|thomas|gordon|lee|nathan|google)\b/i;
// Voices that people hear as warm and natural, by language (higher = better).
const WARM = {
  en: [[/\b(ava|allison|zoe|nicky)\b/i, 90], [/^samantha\b/i, 80], [/^(karen|moira|tessa|serena|kate|susan|stephanie|fiona)\b/i, 65], [/^(flo|shelley|sandy)\b/i, 45]],
  hi: [[/^lekha\b/i, 85]],
  es: [[/\b(paulina|marisol|angelica|angélica|francisca|isabela|monica|mónica|soledad|luciana)\b/i, 85], [/^(flo|shelley|sandy)\b/i, 45]],
};

const primary = (tag) => String(tag).toLowerCase().split("-")[0];

/** Score one voice for a language tag; null means "never use". Pure, so it is unit-tested with real voice lists. */
export function scoreVoice(v, langTag) {
  if (primary(v.lang) !== primary(langTag)) return null;
  if (NOVELTY.test(v.name)) return null;
  let s = 10;
  if (/premium|enhanced|neural|natural/i.test(v.name)) s = 100;
  for (const [re, pts] of WARM[primary(langTag)] ?? []) if (re.test(v.name)) { s = Math.max(s, pts); break; }
  if (MALE.test(v.name)) s -= 30;
  if (!v.localService) s -= 12;                         // network voices add latency and tend to sound flatter
  if (v.lang.replace("_", "-").toLowerCase() === String(langTag).toLowerCase()) s += 5; // exact regional match
  return s;
}

export function pickVoice(voices, langTag) {
  let best = null, bestScore = -Infinity;
  for (const v of voices) { const s = scoreVoice(v, langTag); if (s !== null && s > bestScore) { best = v; bestScore = s; } }
  return best;
}

const DEVANAGARI = /[ऀ-ॿ]/;
const ES_WORDS = /\b(el|la|los|las|que|qué|está|estás|tu|tus|se|de|del|y|para|por|con|hoy|puedo|ayudarte|compras?|pedido)\b/gi;
/** Which language a reply is in, so the right voice speaks it. Script first, then Spanish cues, else the fallback. */
export function detectLang(text, fallback = "en-US") {
  if (DEVANAGARI.test(text)) return "hi-IN";
  const hits = (text.match(ES_WORDS) ?? []).length;
  if (/[¿¡ñ]/.test(text) || (/[áéíóú]/i.test(text) && hits >= 1) || hits >= 3) return "es-MX";
  return fallback;
}

export function splitSentences(text) {
  return String(text).replace(/\s+/g, " ").trim().split(/(?<=[.!?।])\s+/).filter(Boolean);
}

function browserSpeak(text, langTag = "en-US", { rate = 1.03, pitch = 1.06 } = {}) {
  return new Promise((resolve) => {
    const synth = globalThis.speechSynthesis;
    if (!synth || !text.trim()) return resolve();
    const voice = pickVoice(synth.getVoices(), langTag);
    const parts = splitSentences(text);
    let i = 0, done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(watchdog); resolve(); } };
    const watchdog = setTimeout(() => { synth.cancel(); finish(); }, Math.max(5000, text.length * 110)); // never hang on a missing onend
    const next = () => {
      if (done) return;
      if (i >= parts.length) return finish();
      const u = new SpeechSynthesisUtterance(parts[i++]);
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : langTag;
      u.rate = rate; u.pitch = pitch;
      u.onend = next; u.onerror = next;
      synth.speak(u);
    };
    synth.cancel();
    next();
  });
}

// ---- the neural voice ----------------------------------------------------------------------------------------------
// When the server has a neural voice installed (npm run tts:setup) Alexa+ speaks with it; otherwise, or if a sentence fails, with
// the browser's own voices below. The audio comes from the server's /api/speak, one sentence at a time, the next one fetched while
// the current one plays.
let neural = null; // { token: () => string, fails: number } while the neural voice is in use
let speakRun = 0;  // each call to speak or stop supersedes the one before
let current = null; // { audio, finish } for the sentence that is playing

/** Ask the server whether it has a neural voice; a server that has just started needs a few seconds to load it, so keep asking for a while. */
export async function enableNeuralVoice(getToken, { tries = 1, delay = 4000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch("/api/speak/status", { headers: { authorization: `Bearer ${getToken()}` } });
      neural = r.ok && (await r.json()).neural ? { token: getToken, fails: 0 } : null;
    } catch { neural = null; }
    if (neural || i === tries - 1) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return neuralActive();
}
export const neuralActive = () => neural !== null;

/** Sentences, each short enough for the endpoint's limit. */
export function speakChunks(text, max = 500) {
  return splitSentences(text).flatMap((s) => {
    const out = [];
    while (s.length > max) { const cut = s.lastIndexOf(" ", max); const at = cut > 0 ? cut : max; out.push(s.slice(0, at)); s = s.slice(at).trim(); }
    return s ? [...out, s] : out;
  });
}

function playBlob(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob), audio = new Audio(url);
    let settled = false;
    const finish = (ok = true) => { if (settled) return; settled = true; current = null; URL.revokeObjectURL(url); resolve(ok); };
    current = { audio, finish: () => { try { audio.pause(); } catch { /* gone */ } finish(true); } };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    audio.play().catch(() => finish(false)); // autoplay can be refused before the person has interacted with the page
  });
}

async function neuralSpeak(text, langTag, opts) {
  const run = ++speakRun;
  const lang = /^es/i.test(langTag) ? "es" : /^hi/i.test(langTag) ? "hi" : "en";
  const parts = speakChunks(text);
  const fetchPart = (p) => {
    const req = fetch("/api/speak", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${neural.token()}` }, body: JSON.stringify({ text: p, lang }) })
      .then((r) => { if (!r.ok) throw new Error(`speak ${r.status}`); return r.blob(); });
    req.catch(() => {}); // a fetch nobody awaited (because the person interrupted) must not become an unhandled rejection
    return req;
  };
  const queue = parts.map((p, i) => (i < 2 ? fetchPart(p) : null));
  for (let i = 0; i < parts.length; i++) {
    if (run !== speakRun) return;
    if (i + 2 < parts.length && !queue[i + 2]) queue[i + 2] = fetchPart(parts[i + 2]);
    let ok = false;
    try { const blob = await queue[i]; if (run !== speakRun) return; ok = await playBlob(blob); } catch { ok = false; }
    if (run !== speakRun) return;
    if (!ok) { // fall back to the browser's voice for what is left, and give up on the neural one for good after a second failure
      if (neural && ++neural.fails >= 2) neural = null;
      return browserSpeak(parts.slice(i).join(" "), langTag, opts);
    }
    if (neural) neural.fails = 0;
  }
}

export function speakAloud(text, langTag = "en-US", opts = {}) {
  if (!text.trim()) return Promise.resolve();
  stopSpeaking();
  return neural ? neuralSpeak(text, langTag, opts) : browserSpeak(text, langTag, opts);
}

export function stopSpeaking() {
  speakRun++; // supersedes any neural speech in progress
  current?.finish();
  try { globalThis.speechSynthesis?.cancel(); } catch { /* unsupported */ }
}

export function voiceName(langTag) {
  const v = globalThis.speechSynthesis ? pickVoice(globalThis.speechSynthesis.getVoices(), langTag) : null;
  return v ? v.name : null;
}

let audio;
/** A short rising two-note blip: "I'm listening". Original tones, generated here; not Amazon's earcon. */
export function chime() {
  try {
    audio ??= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    const t = audio.currentTime;
    [[660, 0], [880, 0.09]].forEach(([f, d]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.08, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.14);
      o.connect(g).connect(audio.destination); o.start(t + d); o.stop(t + d + 0.16);
    });
  } catch { /* no audio available: silent is fine */ }
}
