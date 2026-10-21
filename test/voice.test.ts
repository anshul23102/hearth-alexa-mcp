import test from "node:test";
import assert from "node:assert/strict";

type V = { name: string; lang: string; localService: boolean };
const v = (name: string, lang: string, localService = true): V => ({ name, lang, localService });

// The voices that were really installed on the developer's Mac (Chrome, macOS), trimmed to what matters for ranking.
const MAC = [
  v("Samantha", "en-US"), v("Albert", "en-US"), v("Bad News", "en-US"), v("Bells", "en-US"), v("Daniel", "en-GB"), v("Eddy (English (United States))", "en-US"),
  v("Flo (English (United States))", "en-US"), v("Fred", "en-US"), v("Grandma (English (United States))", "en-US"), v("Karen", "en-AU"), v("Moira", "en-IE"),
  v("Rishi", "en-IN"), v("Reed (English (United States))", "en-US"), v("Shelley (English (United States))", "en-US"), v("Tessa", "en-ZA"), v("Whisper", "en-US"),
  v("Lekha", "hi-IN"), v("Google हिन्दी", "hi-IN", false),
  v("Mónica", "es-ES"), v("Paulina", "es-MX"), v("Eddy (Spanish (Mexico))", "es-MX"), v("Reed (Spanish (Mexico))", "es-MX"),
];

test("the voice picker chooses a warm natural voice per language from what is really installed", async () => {
  const { pickVoice } = await import("../web/speech.js" as string) as { pickVoice: (vs: V[], l: string) => V | null };
  assert.equal(pickVoice(MAC, "en-US")?.name, "Samantha");
  assert.equal(pickVoice(MAC, "hi-IN")?.name, "Lekha", "local Lekha beats the network voice");
  assert.equal(pickVoice(MAC, "es-MX")?.name, "Paulina");
  assert.equal(pickVoice(MAC, "es-ES")?.name, "Mónica");
  assert.equal(pickVoice(MAC, "fr-FR"), null, "no voice for a language nothing speaks");
});

test("novelty voices are never used, male voices lose to female ones, premium voices win", async () => {
  const { pickVoice, scoreVoice } = await import("../web/speech.js" as string) as { pickVoice: (vs: V[], l: string) => V | null; scoreVoice: (v: V, l: string) => number | null };
  assert.equal(scoreVoice(v("Bad News", "en-US"), "en-US"), null);
  assert.equal(scoreVoice(v("Whisper", "en-US"), "en-US"), null);
  assert.equal(pickVoice([v("Albert", "en-US"), v("Bells", "en-US")], "en-US"), null, "only novelty voices installed: stay silent rather than sing");
  assert.equal(pickVoice([v("Alex", "en-US"), v("Zoe", "en-US")], "en-US")?.name, "Zoe");
  assert.equal(pickVoice([...MAC, v("Ava (Premium)", "en-US")], "en-US")?.name, "Ava (Premium)", "a downloaded Premium voice beats everything");
  assert.equal(pickVoice([v("Samantha", "en-US", false), v("Karen", "en-AU")], "en-US")?.name, "Samantha", "an exact-language match is kept over a nearby accent");
});

test("reply language is detected from script and Spanish cues, so the right voice speaks it", async () => {
  const { detectLang, splitSentences } = await import("../web/speech.js" as string) as { detectLang: (t: string, f?: string) => string; splitSentences: (t: string) => string[] };
  assert.equal(detectLang("You are low on dog food."), "en-US");
  assert.equal(detectLang("ठीक है, अब से हिन्दी में बात होगी।"), "hi-IN");
  assert.equal(detectLang("Se te está acabando la pasta de dientes Colgate."), "es-MX");
  assert.equal(detectLang("¿Qué se nos está acabando?"), "es-MX");
  assert.equal(detectLang("Okay, I will order the plan.", "en-IN"), "en-IN", "the fallback is respected for English");
  assert.deepEqual(splitSentences("One thing.  Two things! Three?"), ["One thing.", "Two things!", "Three?"]);
  assert.deepEqual(splitSentences("पहला वाक्य। दूसरा वाक्य।"), ["पहला वाक्य।", "दूसरा वाक्य।"]);
});

// ---- turn-taking, driven by a fake microphone ------------------------------------------------------------------
class FakeSR {
  static all: FakeSR[] = [];
  lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
  onresult: any; onend: any; onerror: any; onstart: any;
  started = false; aborted = false; ended = false;
  constructor() { FakeSR.all.push(this); }
  start() { this.started = true; setTimeout(() => { if (!this.aborted && !this.ended) this.onstart?.(); }, 0); }
  abort() { this.aborted = true; }
  say(text: string) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
  silence() { this.ended = true; this.onend?.(); }   // a real recognizer is no longer live once it ends
  static get live() { return FakeSR.all.filter((r) => r.started && !r.aborted && !r.ended); }
  static get last() { return FakeSR.all[FakeSR.all.length - 1]; }
}

async function harness() {
  const { createVoice } = await import("../web/voice.js" as string) as { createVoice: (o: any) => any };
  FakeSR.all = [];
  const commands: string[] = [], states: string[] = []; let wakes = 0;
  const voice = createVoice({ SR: FakeSR, getLang: () => "en-US", onCommand: (t: string) => commands.push(t), onWake: () => wakes++, onState: (s: string) => states.push(s) });
  return { voice, commands, states, get wakes() { return wakes; } };
}
const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test("hands-free: only speech that starts with 'Alexa' is acted on, background talk is ignored", async () => {
  const h = await harness();
  h.voice.setHands(true);
  assert.equal(FakeSR.last.continuous, true, "waiting for the wake word uses continuous recognition");
  FakeSR.last.say("what a lovely day, anyway about dinner");
  assert.deepEqual(h.commands, [], "no wake word, no action");
  FakeSR.last.say("Alexa, what are we running low on?");
  assert.deepEqual(h.commands, ["what are we running low on?"], "the wake word is stripped and the rest is the request");
  h.voice.stop();
});

test("follow-ups need no wake word, silence ends the conversation, and hands-free goes back to waiting", async () => {
  const h = await harness();
  h.voice.setHands(true);
  FakeSR.last.say("Alexa what is low");
  h.voice.pause();                                             // Alexa is thinking and speaking
  assert.ok(FakeSR.all.every((r) => r.aborted || !r.started || r !== FakeSR.last) || FakeSR.last.aborted, "the mic is closed while she speaks");
  assert.equal(FakeSR.live.length, 0, "nothing is listening while she speaks, so she cannot hear herself");
  h.voice.afterReply();                                        // she finished: open the follow-up window
  assert.equal(FakeSR.last.continuous, false, "follow-up is a one-shot listen");
  FakeSR.last.say("and are any of my appliances recalled");    // no 'Alexa' this time
  assert.deepEqual(h.commands, ["what is low", "and are any of my appliances recalled"]);
  h.voice.pause(); h.voice.afterReply();
  FakeSR.last.silence();                                       // nobody answered within the window
  await tick();
  assert.equal(FakeSR.last.continuous, true, "back to waiting for 'Alexa'");
  FakeSR.last.say("just talking to myself");
  assert.equal(h.commands.length, 2, "and the wake word is required again");
  h.voice.stop();
});

test("saying only 'Alexa' chimes and then listens for the request", async () => {
  const h = await harness();
  h.voice.setHands(true);
  FakeSR.last.say("Alexa");
  assert.equal(h.wakes, 1);
  assert.equal(FakeSR.last.continuous, false, "now listening for the actual request");
  FakeSR.last.say("order the dog food");
  assert.deepEqual(h.commands, ["order the dog food"]);
  const hindi = await harness();
  hindi.voice.setHands(true);
  FakeSR.last.say("अलेक्सा आज क्या खत्म हो रहा है");
  assert.deepEqual(hindi.commands, ["आज क्या खत्म हो रहा है"], "the wake word works in Devanagari too");
  h.voice.stop(); hindi.voice.stop();
});

test("the mic button opens a conversation without hands-free, and it closes itself on silence", async () => {
  const h = await harness();
  h.voice.start();
  assert.equal(h.voice.active, true);
  FakeSR.last.say("is the dog food low");
  assert.deepEqual(h.commands, ["is the dog food low"]);
  h.voice.pause(); h.voice.afterReply();
  FakeSR.last.silence();
  await tick();
  assert.equal(h.voice.active, false, "the conversation ended");
  assert.equal(FakeSR.live.length, 0, "and the microphone is off");
  assert.equal(h.states[h.states.length - 1], "idle");
});

test("a blocked microphone is reported and stops everything", async () => {
  const h = await harness();
  h.voice.setHands(true);
  FakeSR.last.onerror({ error: "not-allowed" });
  assert.equal(h.states[h.states.length - 1], "blocked");
  assert.equal(h.voice.active, false);
});

test("wake-word stripping", async () => {
  const { stripWake } = await import("../web/voice.js" as string) as { stripWake: (t: string) => string | null };
  assert.equal(stripWake("Alexa what's low"), "what's low");
  assert.equal(stripWake("hey alexa, plan a restock"), "plan a restock");
  assert.equal(stripWake("Alexa"), "");
  assert.equal(stripWake("nothing here"), null);
  assert.equal(stripWake("I need electricity"), null, "must not trigger on a word that merely contains letters");
});

test("the offline router keeps conversational context: follow-ups about an item just discussed, thanks, and no", async () => {
  const { localStep } = await import("../web/agent.js" as string) as { localStep: (m: any[], o: any) => { content: { type: string; text?: string; name?: string }[] } };
  const items = [
    { name: "Kirkland dog food", daysLeft: 0, windowDays: 2, confidence: "high", purchases: 25 },
    { name: "Bounty paper towels", daysLeft: 9, windowDays: 2, confidence: "high", purchases: 27 },
    { name: "Colgate toothpaste", daysLeft: -4, windowDays: 7, confidence: "medium", purchases: 9 },
  ];
  const history = [
    { role: "user", content: [{ type: "text", text: "what are we running low on" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "household_runway", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", text: "3 items", structured: { view: "runway", items } }] },
    { role: "assistant", content: [{ type: "text", text: "3 items run out soon." }] },
  ];
  const ask = (text: string) => localStep([...history, { role: "user", content: [{ type: "text", text }] }], { sampleCsv: "" }).content[0];
  assert.match(ask("what about the dog food?").text!, /Kirkland dog food: it runs out today, give or take 2\. high confidence, from 25 orders/);
  assert.match(ask("and the toothpaste?").text!, /ran out about 4 days ago/);
  assert.match(ask("tell me about the paper towels").text!, /about 9 days left/);
  assert.match(ask("thanks!").text!, /welcome/i);
  assert.match(ask("no thanks").text!, /Say Alexa/);
  assert.equal(ask("plan a restock for the dog food").name, "plan_restock", "an action request is not mistaken for a question about an item");
  const nothing = localStep([{ role: "user", content: [{ type: "text", text: "what about the dog food" }] }], { sampleCsv: "" }).content[0];
  assert.ok(nothing.type === "tool_use" || /can tell you/.test(nothing.text ?? ""), "without a runway on screen it does not invent details");
});

test("pressing a card button leaves a valid conversation the model can continue", async () => {
  // The browser records a press as: user text, assistant tool_use, user tool_result, assistant text.
  const { toConverse } = await import("../src/agent.js");
  const id = "ui_1";
  const wire = [
    { role: "user", content: [{ type: "text", text: "plan a restock" }] },
    { role: "assistant", content: [{ type: "text", text: "Here is a plan. Place it?" }] },
    { role: "user", content: [{ type: "text", text: "(I pressed “Place order” on the card.)" }] },
    { role: "assistant", content: [{ type: "tool_use", id, name: "confirm_restock", input: { proposalId: "prop_1", userConfirmed: true } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, text: "Done." }] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
    { role: "user", content: [{ type: "text", text: "and what else is low?" }] },
  ] as any;
  const c = toConverse(wire);
  assert.ok(c.every((m, i) => i === 0 || m.role !== c[i - 1].role), "alternating roles");
  c.forEach((m, i) => (m.content ?? []).forEach((b: any) => { if (b.toolResult) assert.ok(c[i - 1].content!.some((x: any) => x.toolUse?.toolUseId === b.toolResult.toolUseId), "result has its call"); }));
});
