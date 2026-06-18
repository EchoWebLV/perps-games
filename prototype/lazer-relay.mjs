/* ============================================================================
   lazer-relay.mjs — production-safe Pyth Lazer relay
   ----------------------------------------------------------------------------
   The browser must NOT hold a Lazer access token (Pyth's words: "never expose
   access tokens in frontend applications"). This tiny relay holds the token
   server-side, opens an authenticated upstream connection to Lazer, and
   rebroadcasts the stream to browsers over a token-free local WebSocket.

   Each browser that connects gets its own upstream connection and sends its own
   `subscribe` message (the games already do this) — the relay just injects the
   Authorization header. That's the whole trick.

   ── RUN ──────────────────────────────────────────────────────────────────────
       npm i ws
       LAZER_TOKEN=your_token_here node lazer-relay.mjs
       # then open:  http://localhost:8765/redline.html?relay=ws://localhost:8787
       #             http://localhost:8765/minefield.html?relay=ws://localhost:8787

   Env: LAZER_TOKEN (required), PORT (default 8787), UPSTREAM (default endpoint 0)
   ============================================================================ */
import { WebSocketServer, WebSocket } from "ws";

const TOKEN = process.env.LAZER_TOKEN;
const PORT = Number(process.env.PORT || 8787);
const UPSTREAM = process.env.UPSTREAM || "wss://pyth-lazer-0.dourolabs.app/v1/stream";

if (!TOKEN) {
  console.error("✗ Set LAZER_TOKEN — get one at https://pyth.network/lazer");
  process.exit(1);
}

const wss = new WebSocketServer({ port: PORT });
console.log(`✓ Lazer relay listening on ws://localhost:${PORT}  →  ${UPSTREAM}`);

wss.on("connection", (down, req) => {
  const peer = req.socket.remoteAddress;
  const up = new WebSocket(UPSTREAM, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const queue = [];

  up.on("open", () => { while (queue.length) up.send(queue.shift()); });
  up.on("message", (m) => { if (down.readyState === WebSocket.OPEN) down.send(m.toString()); });
  up.on("close", () => { try { down.close(); } catch {} });
  up.on("error", (e) => { console.error(`upstream error (${peer}):`, e.message); try { down.close(); } catch {} });

  down.on("message", (m) => { const s = m.toString(); up.readyState === WebSocket.OPEN ? up.send(s) : queue.push(s); });
  down.on("close", () => { try { up.close(); } catch {} });
  down.on("error", () => { try { up.close(); } catch {} });
});
