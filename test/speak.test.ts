import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { ChildProcess } from "node:child_process";
import { link, startServer } from "./helpers.js";

// The page speaks with a neural voice when the server has one. These tests put a stand-in voice (a tiny HTTP server that returns
// recognisable bytes) behind the real endpoint and check what Hearth enforces: who may ask, what may be asked, and what happens when
// the voice is slow, broken or missing.
const FAKE_PORT = 3995, HEARTH_PORT = 3996, NONE_PORT = 3997;
const WAV = Buffer.concat([Buffer.from("RIFF....WAVEfmt "), Buffer.alloc(40, 7)]);
let fake: Server, proc: ChildProcess, base = "", token = "", calls = 0, mode: "ok" | "broken" = "ok";
const asked: { text: string; voice: string; lang: string }[] = [];

before(async () => {
  fake = createServer((req, res) => {
    if (req.method === "GET") { res.writeHead(200).end("ok"); return; } // the readiness probe
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      calls++; asked.push(JSON.parse(b));
      if (mode === "broken") { res.writeHead(500).end("no"); return; }
      res.writeHead(200, { "content-type": "audio/wav" }).end(WAV);
    });
  }).listen(FAKE_PORT);
  ({ proc, base } = await startServer(HEARTH_PORT, { HEARTH_TTS: "on", HEARTH_TTS_URL: `http://127.0.0.1:${FAKE_PORT}` }));
  token = (await link(base)).access_token;
  for (let i = 0; i < 40; i++) { // the server finds the voice in the background
    const r = await fetch(`${base}/api/speak/status`, { headers: { authorization: `Bearer ${token}` } });
    if (((await r.json()) as { neural: boolean }).neural) break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
});
after(() => { proc?.kill(); fake?.close(); });

const speak = (body: unknown, auth: string | null = token) => fetch(`${base}/api/speak`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("only a signed-in person can have text spoken, and the status says the voice is there", async () => {
  assert.equal((await speak({ text: "hi", lang: "en" }, null)).status, 401);
  assert.equal((await speak({ text: "hi", lang: "en" }, "not-a-token")).status, 401);
  assert.equal((await fetch(`${base}/api/speak/status`)).status, 401);
  const st = await fetch(`${base}/api/speak/status`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await st.json(), { neural: true });
});

test("what may be asked is bounded: short text, three languages, JSON only", async () => {
  assert.equal((await speak({ text: "", lang: "en" })).status, 400);
  assert.equal((await speak({ text: "x".repeat(601), lang: "en" })).status, 400);
  assert.equal((await speak({ text: "hello", lang: "fr" })).status, 400);
  assert.equal((await speak({ text: 42, lang: "en" })).status, 400);
  assert.equal((await speak("{not json")).status, 400);
  assert.equal((await fetch(`${base}/api/speak`, { headers: { authorization: `Bearer ${token}` } })).status, 405);
  assert.equal(calls, 0, "nothing invalid ever reached the voice");
});

test("a good request returns the voice's audio, picks the voice for the language, and repeats are answered from memory", async () => {
  const r = await speak({ text: "Your pressure cooker is covered by a recall.", lang: "en" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), WAV);
  assert.equal(asked.at(-1)!.lang, "en-us");
  const before = calls;
  await (await speak({ text: "Your pressure cooker is covered by a recall.", lang: "en" })).arrayBuffer();
  assert.equal(calls, before, "the same sentence is not synthesised twice");
  await (await speak({ text: "Hola, ¿qué se acaba?", lang: "es" })).arrayBuffer();
  assert.equal(asked.at(-1)!.lang, "es");
  await (await speak({ text: "नमस्ते", lang: "hi" })).arrayBuffer();
  assert.equal(asked.at(-1)!.lang, "hi");
  assert.notEqual(asked.at(-1)!.voice, asked[0].voice, "each language has its own voice");
});

test("when the voice fails the page is told so and can use the browser's voice", async () => {
  mode = "broken";
  assert.equal((await speak({ text: "this one will fail", lang: "en" })).status, 502);
  mode = "ok";
});

test("without a voice installed the endpoint says so and the status is false", async () => {
  const { proc: p2, base: b2 } = await startServer(NONE_PORT); // HEARTH_TTS=off
  try {
    const t2 = (await link(b2)).access_token;
    assert.deepEqual(await (await fetch(`${b2}/api/speak/status`, { headers: { authorization: `Bearer ${t2}` } })).json(), { neural: false });
    const r = await fetch(`${b2}/api/speak`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t2}` }, body: JSON.stringify({ text: "hi", lang: "en" }) });
    assert.equal(r.status, 503);
  } finally { p2.kill(); }
});

test("the page may play the audio the endpoint returns (CSP media-src), and nothing wider", async () => {
  const csp = (await fetch(base)).headers.get("content-security-policy")!;
  assert.match(csp, /media-src 'self' blob:/);
  assert.ok(!/media-src[^;]*\*/.test(csp));
});
