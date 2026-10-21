import { parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db.js";
import { ingestStream } from "./ingest.js";

// Runs one bulk import on its own SQLite connection (WAL lets readers continue) so the HTTP
// event loop keeps serving other households while a million-row export is processed.

const port = parentPort!;
const { dbPath, household, maxBytes, maxRows } = workerData as { dbPath: string; household: string; maxBytes: number; maxRows: number };
const db = openDb(dbPath);
db.exec("PRAGMA busy_timeout = 15000");

const queue: Uint8Array[] = [];
let ended = false;
let wake: (() => void) | null = null;
port.on("message", (m: { type: "chunk"; buf: Uint8Array } | { type: "end" }) => {
  if (m.type === "chunk") queue.push(m.buf); else ended = true;
  wake?.(); wake = null;
});

async function* source() {
  for (;;) {
    while (queue.length) { const b = queue.shift()!; port.postMessage({ type: "ack" }); yield b; }
    if (ended) return;
    await new Promise<void>((r) => (wake = r));
  }
}

ingestStream(db, household, source(), { maxBytes, maxRows })
  .then((report) => port.postMessage({ type: "done", report }))
  .catch((e: Error) => port.postMessage({ type: "error", message: e.message }))
  .finally(() => db.close());
