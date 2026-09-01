/* ============================================================================
   feed.ts — server-fed prices for the games
   ----------------------------------------------------------------------------
   The game server is the ONLY price source the browser talks to. It holds the
   oracle credential; the client holds none. Two rails, in order:

     1) WS  ws(s)://<API_BASE>/v1/feed  — push, ~4/s, messages:
            { type: "tick",  symbol, price, tsUs }
            { type: "stale", symbol }                 (server has no fresh price)
     2) GET <API_BASE>/v1/prices        — poll backstop, used only while the WS
                                          has been silent for >1200ms

   If both are down the caller's price source falls through to its local sim, so
   games ALWAYS run. No third-party endpoint and no API key ships in the bundle.
   ============================================================================ */

export interface FeedSpec { key: string; }
export interface FeedStatus { source: string; live: boolean; rate: number; label: string; }
/** The slice of `fetch` the backstop poll uses — narrow enough for a test to stand in for. */
export type FeedFetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
export interface FeedOpts {
  feeds: FeedSpec[];
  onPrice: (key: string, price: number, tsUs?: number) => void;
  onStatus?: (s: FeedStatus) => void;
  /** Test seam: a WebSocket-compatible constructor (defaults to the global). */
  wsCtor?: typeof WebSocket;
  /** Test seam: override the API origin (defaults to VITE_API_BASE). */
  apiBase?: string;
  /** Test seam: the fetch the /v1/prices backstop uses (defaults to the global). */
  fetchImpl?: FeedFetch;
}
export interface FeedHandle { state: FeedStatus; stop: () => void; }

const RECONNECT_MIN_MS = 400;
const RECONNECT_MAX_MS = 4000;
const SILENCE_MS = 1200;   // no WS message for this long → the HTTP poll takes over
const POLL_MS = 600;

function viteApiBase(): string {
  let base = "http://localhost:8080";
  try { base = (import.meta.env.VITE_API_BASE as string | undefined) || base; } catch { /* non-vite */ }
  return base;
}

/** ws:// for http://, wss:// for https:// — same origin as the REST API. */
export function feedWsUrl(apiBase: string): string {
  return apiBase.replace(/\/$/, "").replace(/^http/, "ws") + "/v1/feed";
}

export function connectFeed(opts: FeedOpts): FeedHandle {
  const feeds = opts.feeds || [];
  const onPrice = opts.onPrice || function () {};
  const onStatus = opts.onStatus || function () {};
  // null-prototype: a symbol named "constructor"/"toString" would otherwise hit Object.prototype
  // and read as subscribed.
  const byKey: Record<string, FeedSpec> = Object.create(null);
  feeds.forEach(function (f) { byKey[f.key] = f; });

  const apiBase = (opts.apiBase || viteApiBase()).replace(/\/$/, "");
  const pricesUrl = apiBase + "/v1/prices";
  const WsCtor: typeof WebSocket | null =
    opts.wsCtor || (typeof WebSocket !== "undefined" ? WebSocket : null);
  const doFetch: FeedFetch | null =
    opts.fetchImpl || (typeof fetch !== "undefined" ? function (u: string) { return fetch(u); } : null);

  const state: FeedStatus = { source: "server", live: false, rate: 0, label: "connecting…" };
  const ticks: number[] = [];                                // timestamps of recent updates (for rate)
  let ws: WebSocket | null = null, fails = 0, killed = false, stale = false;
  // WS liveness ONLY — the poll must never re-arm this, or its own delivery would gate the
  // next one and the backstop's effective cadence would double (POLL_MS + SILENCE_MS).
  let wsLastMsg = 0;                                         // 0 = no WS frame yet this connection
  let pollInFlight = false;

  function now() { return Date.now(); }
  function bump() {
    const t = now(); ticks.push(t);
    while (ticks.length && t - ticks[0] > 1000) ticks.shift();
  }
  function emit(key: string, price: number, tsUs?: number) {
    if (!(price > 0)) return;
    state.live = true; stale = false; bump();
    try { onPrice(key, price, tsUs); } catch (e) {}
  }

  // ---------- server WS (primary) ----------
  function openWs() {
    if (killed || !WsCtor) return;
    state.label = "connecting…";
    try { ws = new WsCtor(feedWsUrl(apiBase)); } catch (e) { onWsDown(); return; }

    ws.onopen = function () { fails = 0; };
    ws.onmessage = function (ev: MessageEvent) {
      let d: any; try { d = JSON.parse(ev.data); } catch (e) { return; }
      wsLastMsg = now();
      const key = String(d && d.symbol || "");
      if (!byKey[key]) return;                               // a symbol this caller didn't ask for
      if (d.type === "stale") { stale = true; state.live = false; return; }
      if (d.type !== "tick") return;
      emit(key, Number(d.price), d.tsUs == null ? undefined : Number(d.tsUs));
    };
    ws.onerror = function () { /* close fires next */ };
    ws.onclose = function () { ws = null; onWsDown(); };
  }
  function onWsDown() {
    if (killed) return;
    ws = null; fails++; wsLastMsg = 0;                       // the rail is gone: stop gating the poll
    state.live = false; state.label = "reconnecting…";
    setTimeout(openWs, Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * fails));
  }

  // ---------- GET /v1/prices (backstop) ----------
  // Only fires while the WS has been quiet; the server holds the oracle key, so
  // this is the same price by a slower road — never a third-party endpoint.
  function wsQuiet() { return wsLastMsg === 0 || now() - wsLastMsg >= SILENCE_MS; }
  function apiPollOnce() {
    // Single-flight: a server slow enough to outlast the interval would otherwise
    // get a growing pile of concurrent requests from a client it is already failing.
    if (killed || !doFetch || pollInFlight || !wsQuiet()) return;
    pollInFlight = true;
    const done = function () { pollInFlight = false; };
    try {
      doFetch(pricesUrl)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (raw) {
          const d = raw as { prices?: Record<string, number> } | null;
          const prices = d && d.prices;
          if (!prices) return;
          for (let i = 0; i < feeds.length; i++) {
            // An asset the server judged unhealthy is simply absent from `prices`.
            const f = feeds[i], v = Number(prices[f.key]);
            if (v > 0) emit(f.key, v);
          }
        })
        .catch(function () {})
        .then(done, done);
    } catch (e) { done(); }
  }
  const apiPoll: ReturnType<typeof setInterval> = setInterval(apiPollOnce, POLL_MS);

  // ---------- status heartbeat ----------
  const statusTimer = setInterval(function () {
    const t = now();
    while (ticks.length && t - ticks[0] > 1000) ticks.shift();
    state.rate = ticks.length;
    state.live = ticks.length > 0;
    if (state.live) state.label = "Slopwheels feed · " + state.rate + "/s";
    else state.label = stale ? "feed stale" : (ws ? "waiting for prices…" : "reconnecting…");
    try { onStatus(state); } catch (e) {}
  }, 250);

  // ---------- start ----------
  if (WsCtor) openWs();
  else state.label = "no WebSocket available";

  return {
    state: state,
    stop: function () {
      killed = true; clearInterval(statusTimer); clearInterval(apiPoll);
      try { if (ws) ws.close(); } catch (e) {}
      ws = null;
    }
  };
}

export function config() { return { apiBase: viteApiBase(), wsUrl: feedWsUrl(viteApiBase()) }; }
