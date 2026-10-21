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

export function speakAloud(text, langTag = "en-US", { rate = 1.03, pitch = 1.06 } = {}) {
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

export function stopSpeaking() { try { globalThis.speechSynthesis?.cancel(); } catch { /* unsupported */ } }

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
