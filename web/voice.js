// Turn-taking for a spoken conversation, the way Alexa behaves:
//   - "Alexa" (hands-free) or the mic button starts a conversation,
//   - after every spoken reply the mic re-opens for a follow-up, with no wake word needed,
//   - silence ends the conversation; hands-free then goes back to waiting for "Alexa".
// The browser's SpeechRecognition cannot hear while the page is speaking (it would transcribe Alexa herself), so the
// controller is paused during replies. Speech recognition in Chrome is sent to Google's service; nothing listens until the
// user presses the mic or turns hands-free on. `SR` is injectable so the state machine is unit-tested without a microphone.

const WAKE = /\b(alexa|alexia|alexsa|a lexa)\b|अलेक्सा|आलेक्सा|एलेक्सा|एलेक्स्सा/i;

export function stripWake(text) {
  const m = text.match(WAKE);
  if (!m) return null;
  return text.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, "").trim();
}

export function createVoice({ SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition, getLang, onCommand, onWake, onState }) {
  let hands = false;        // always waiting for the wake word
  let convo = false;        // a conversation is open: listen for follow-ups without a wake word
  let paused = false;       // true while Alexa speaks or thinks
  let rec = null;
  let gotSpeech = false;

  const emit = (s) => onState?.(s);
  const stopRec = () => { if (rec) { const r = rec; rec = null; r.onresult = r.onerror = r.onend = null; try { r.abort(); } catch { /* already stopped */ } } };

  function listen(continuous) {
    if (!SR || paused) return;
    stopRec();
    const r = new SR();
    rec = r; gotSpeech = false;
    r.lang = getLang(); r.continuous = continuous; r.interimResults = false; r.maxAlternatives = 1;
    r.onstart = () => emit(continuous ? "waiting" : "listening");
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        gotSpeech = true;
        handle(String(e.results[i][0].transcript).trim());
      }
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { hands = false; convo = false; stopRec(); emit("blocked"); }
    };
    r.onend = () => {
      if (rec !== r) return;                 // replaced or paused on purpose
      rec = null;
      if (paused) return;
      if (convo && !gotSpeech) {             // follow-up window passed in silence: the conversation is over
        convo = false;
        if (hands) return listen(true);
        emit("idle");
        return;
      }
      if (!gotSpeech && hands && !convo) return setTimeout(() => listen(true), 150); // continuous recognition times out; keep waiting
      if (!hands && !convo) emit("idle");
    };
    try { r.start(); } catch { /* start() throws if one is already running */ }
  }

  function handle(text) {
    if (!text) return;
    if (convo) { stopRec(); onCommand(text); return; }              // in a conversation: everything is for Alexa
    const cmd = stripWake(text);                                    // waiting: only speech that starts with "Alexa" counts
    if (cmd === null) return;                                       // background talk is ignored
    stopRec();
    if (cmd) { convo = true; onCommand(cmd); }
    else { convo = true; onWake?.(); listen(false); }               // just "Alexa": chime, then listen for the request
  }

  return {
    get supported() { return !!SR; },
    get active() { return convo || hands; },
    get hands() { return hands; },
    /** Mic button: open a conversation now. */
    start() { convo = true; paused = false; listen(false); },
    /** Toggle always-listening for "Alexa". */
    setHands(on) { hands = on; if (on) { paused = false; convo = false; listen(true); } else { convo = false; stopRec(); emit("idle"); } },
    stop() { hands = false; convo = false; paused = false; stopRec(); emit("idle"); },
    /** Call before Alexa thinks/speaks: stop hearing, so she does not transcribe herself. */
    pause() { paused = true; stopRec(); },
    /** Call once the reply has been spoken: open the follow-up window, or go back to waiting. */
    afterReply() {
      paused = false;
      if (convo || hands) { convo = true; listen(false); } else emit("idle");
    },
  };
}
