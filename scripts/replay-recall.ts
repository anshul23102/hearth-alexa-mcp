// Operator tool: replay a real notice from the index as if it had just been published, to show the full
// pipeline (owner lookup -> alert -> push to open Alexa+ sessions). Needs the server started with HEARTH_ADMIN_TOKEN.
//   HEARTH_ADMIN_TOKEN=... npm run demo:recall -- Foodi
const token = process.env.HEARTH_ADMIN_TOKEN;
const base = process.env.HEARTH_URL ?? "http://localhost:3939";
const needle = process.argv[2] ?? "Foodi";
if (!token) { console.error("Set HEARTH_ADMIN_TOKEN to the same value the server was started with."); process.exit(1); }
const res = await fetch(`${base}/api/admin/recalls/replay`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ source: "cpsc", titleContains: needle }) });
const body = await res.json();
if (!res.ok) { console.error(`failed (${res.status}):`, body); process.exit(1); }
console.log(`replayed: ${body.replayed.title} (${body.replayed.date})`);
console.log(`owners alerted: ${body.alerts} alerts across ${body.households} households; pushed to ${body.notifiedSessions} open session(s)`);
