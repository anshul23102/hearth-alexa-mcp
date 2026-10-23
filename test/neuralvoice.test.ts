import test from "node:test";
import assert from "node:assert/strict";

// The page's side of the neural voice: sentence by sentence in order, the next fetched while one plays, the browser's voice as the
// fallback, and stop really stopping. Everything the browser provides is stubbed.
const speech = (await import("../web/speech.js" as string)) as any;

interface Played { url: string }
function install({ failOn = [] as number[], hang = false } = {}) {
  const fetched: string[] = [], played: Played[] = [], spoken: string[] = [];
  let n = 0;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (String(url).endsWith("/api/speak/status")) return new Response(JSON.stringify({ neural: true }), { status: 200 });
    const text = JSON.parse(init.body).text as string; fetched.push(text);
    if (failOn.includes(n++)) return new Response("{}", { status: 502 });
    return new Response(new Blob([text]), { status: 200 });
  };
  (globalThis as any).URL.createObjectURL = (b: Blob) => `blob:${b.size}`;
  (globalThis as any).URL.revokeObjectURL = () => {};
  (globalThis as any).Audio = class { onended: any; onerror: any; constructor(public src: string) {} play() { played.push({ url: this.src }); if (!hang) setTimeout(() => this.onended?.(), 5); return Promise.resolve(); } pause() {} };
  (globalThis as any).speechSynthesis = { getVoices: () => [], cancel() {}, speak(u: any) { spoken.push(u.text); u.onend?.(); } };
  (globalThis as any).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  return { fetched, played, spoken };
}

test("long text is cut into sentences, and sentences that are too long are cut at a space", () => {
  assert.deepEqual(speech.speakChunks("One. Two! Three?"), ["One.", "Two!", "Three?"]);
  const long = ("word ".repeat(200)).trim();
  const parts = speech.speakChunks(long, 100);
  assert.ok(parts.every((p: string) => p.length <= 100) && parts.join(" ") === long);
});

test("with the neural voice on, each sentence is fetched from the server and played in order", async () => {
  const s = install();
  assert.equal(await speech.enableNeuralVoice(() => "tok"), true);
  await speech.speakAloud("First sentence. Second sentence. Third sentence.", "en-US");
  assert.deepEqual(s.fetched, ["First sentence.", "Second sentence.", "Third sentence."]);
  assert.equal(s.played.length, 3);
  assert.deepEqual(s.spoken, [], "the browser's voice was not used");
});

test("if a sentence cannot be fetched the browser's voice finishes the reply, and a second failure turns the neural voice off", async () => {
  const s = install({ failOn: [1] });
  await speech.enableNeuralVoice(() => "tok");
  await speech.speakAloud("Alpha one. Beta two. Gamma three.", "en-US");
  assert.equal(s.played.length, 1, "the first sentence was neural");
  assert.deepEqual(s.spoken, ["Beta two.", "Gamma three."], "the rest was spoken by the browser, nothing was lost");
  const s2 = install({ failOn: [0, 1, 2] }); // two failed turns in a row, with no success between them
  await speech.enableNeuralVoice(() => "tok");
  await speech.speakAloud("One. Two.", "en-US");
  await speech.speakAloud("Three four.", "en-US");
  assert.equal(speech.neuralActive(), false, "after repeated failures the page stops asking the server");
  assert.ok(s2.spoken.length >= 2);
});

test("stop ends the reply at once and the caller is released", async () => {
  const s = install({ hang: true }); // audio that never ends on its own
  await speech.enableNeuralVoice(() => "tok");
  const done = speech.speakAloud("This will be interrupted. And this never plays.", "en-US");
  await new Promise((r) => setTimeout(r, 30));
  speech.stopSpeaking();
  await Promise.race([done, new Promise((_, bad) => setTimeout(() => bad(new Error("speakAloud was never released")), 1000))]);
  assert.equal(s.played.length, 1, "the second sentence never started");
});

test("a language other than English asks the server for that language", async () => {
  const bodies: any[] = [];
  const s = install();
  const base = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, init?: any) => { if (init?.body) bodies.push(JSON.parse(init.body)); return base(url, init); };
  await speech.enableNeuralVoice(() => "tok");
  await speech.speakAloud("Hola, ¿qué se acaba?", "es-MX");
  await speech.speakAloud("नमस्ते।", "hi-IN");
  assert.deepEqual(bodies.map((b) => b.lang), ["es", "hi"]);
  assert.ok(s.played.length === 2);
});

test("a reply spoken right after the neural check starts waits for that first answer, so even the first sentence uses the neural voice", async () => {
  const s = install();
  const status = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, init?: any) => { if (String(url).endsWith("/api/speak/status")) await new Promise((r) => setTimeout(r, 120)); return status(url, init); }; // the answer takes a moment
  void speech.enableNeuralVoice(() => "tok"); // not awaited, as in the page
  await speech.speakAloud("Welcome back.", "en-US");
  assert.equal(s.played.length, 1, "spoken by the neural voice");
  assert.deepEqual(s.spoken, [], "not by the browser's");
});

test("when there is no neural voice the first sentence does not wait for the whole search", async () => {
  const s = install();
  (globalThis as any).fetch = async (url: string) => (String(url).endsWith("/api/speak/status") ? new Response(JSON.stringify({ neural: false }), { status: 200 }) : new Response("{}", { status: 500 }));
  void speech.enableNeuralVoice(() => "tok", { tries: 6, delay: 400 }); // keeps looking for 2 seconds
  const t0 = Date.now();
  await speech.speakAloud("Hello there.", "en-US");
  assert.ok(Date.now() - t0 < 300, `spoke after ${Date.now() - t0} ms, not after the search`);
  assert.deepEqual(s.spoken, ["Hello there."]);
});
