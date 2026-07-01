/* ============================================================================
   feed.ts — Pyth Lazer (a.k.a. "Pyth Pro") low-latency price feed for the games
   ----------------------------------------------------------------------------
   Production target: ~1-50ms updates (real_time channel) straight from Pyth's
   Lazer stream. Falls back to Pyth Hermes SSE (~2-4/s, free, no token) and then
   to the game's own sim if everything is offline — so the games ALWAYS run.

   ── HOW TO TEST WITH LAZER (pick ONE) ───────────────────────────────────────
   A) Quickest: get a Lazer access token from https://pyth.network/lazer
      then open the game with the token in the URL, e.g.
          http://localhost:8765/redline.html?lazer=YOUR_TOKEN
          http://localhost:8765/minefield.html?lazer=YOUR_TOKEN&ch=fixed_rate@50ms
      (the token is remembered in localStorage after the first load)

   B) Hardcode it: paste your token into LAZER_TOKEN below.

   C) Production (recommended — never ship a token in the browser): run the
      relay (see lazer-relay.mjs), which holds the token server-side, then open
          http://localhost:8765/redline.html?relay=ws://localhost:8787
      or set LAZER_RELAY below.

   Channel override: ?ch=real_time | fixed_rate@1ms | fixed_rate@50ms |
                     fixed_rate@200ms | fixed_rate@1000ms      (default real_time)
   ============================================================================ */

export interface FeedSpec { key: string; lz: number; hx: string; expo: number; }
export interface FeedStatus { source: string; live: boolean; rate: number; label: string; }
export interface FeedOpts {
  feeds: FeedSpec[];
  onPrice: (key: string, price: number, tsUs?: number) => void;
  onStatus?: (s: FeedStatus) => void;
}
export interface FeedHandle { state: FeedStatus; stop: () => void; }

// ---- paste-here config (URL params override these) ------------------------
// SECURITY: burner token, ships in the bundle (parity with prototype). Before any
// public release move it server-side via the relay (see spec §7 / lazer-relay.mjs).
const LAZER_TOKEN = "";   // burner token got de-entitled from the crypto feeds → default to the free, no-token Hermes feed (still real Pyth). Re-add a valid token here, or use ?lazer=… / the relay, for low-latency Lazer.
const LAZER_RELAY = "";   // <-- or a relay ws url (token stays server-side)
const DEFAULT_CHANNEL = "real_time";
const HERMES_FALLBACK = true;

const ENDPOINTS = [
  "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  "wss://pyth-lazer-1.dourolabs.app/v1/stream",
  "wss://pyth-lazer-2.dourolabs.app/v1/stream"
];
const HERMES_SSE  = "https://hermes.pyth.network/v2/updates/price/stream";
const HERMES_REST = "https://hermes.pyth.network/v2/updates/price/latest";

// ---- url / storage config -------------------------------------------------
function qp(n: string) { try { return new URLSearchParams(location.search).get(n) || ""; } catch (e) { return ""; } }
const urlTok = qp("lazer") || qp("token");
if (urlTok) { try { localStorage.setItem("lazer_token", urlTok); } catch (e) {} }
const TOKEN = urlTok || (function () { try { return localStorage.getItem("lazer_token") || ""; } catch (e) { return ""; } })() || LAZER_TOKEN;
const RELAY = qp("relay") || LAZER_RELAY;
const CHANNEL = qp("ch") || DEFAULT_CHANNEL;

// ---- per-connection state -------------------------------------------------
export function connectFeed(opts: FeedOpts): FeedHandle {
  const feeds = opts.feeds || [];                 // [{key, lz, hx, expo}]
  const onPrice = opts.onPrice || function () {};
  const onStatus = opts.onStatus || function () {};
  const byLz: Record<string, FeedSpec> = {}, byKey: Record<string, FeedSpec> = {};
  feeds.forEach(function (f) { byLz[f.lz] = f; byKey[f.key] = f; });

  const state: FeedStatus = { source: "off", live: false, rate: 0, label: "connecting…" };
  const ticks: number[] = [];                                // timestamps of recent updates (for rate)
  let ws: WebSocket | null = null, epIdx = 0, lazerFails = 0, killed = false, usingHermes = false;

  // channel ladder fast→slow; illiquid feeds (e.g. AVAX/LINK/JUP @200ms) are
  // auto-downgraded onto a supported rate when the server reports them unsupported.
  const LADDER = ["real_time", "fixed_rate@50ms", "fixed_rate@200ms", "fixed_rate@1000ms"];
  let subCounter = 0;
  let subChannel: Record<string, string> = {}, subFeeds: Record<string, number[]> = {};
  function nextSlower(ch: string) { let i = LADDER.indexOf(ch); if (i < 0) i = 0; return LADDER[i + 1] || null; }
  function subscribeFeeds(ids: number[], channel: string) {
    if (!ids || !ids.length || !ws || ws.readyState !== 1) return;
    const id = ++subCounter; subChannel[id] = channel; subFeeds[id] = ids;
    try { ws.send(JSON.stringify({ type: "subscribe", subscriptionId: id, priceFeedIds: ids, properties: ["price", "exponent"], formats: [], channel: channel, ignoreInvalidFeeds: true })); } catch (e) {}
  }

  function now() { return Date.now(); }
  function bump() {
    const t = now(); ticks.push(t);
    while (ticks.length && t - ticks[0] > 1000) ticks.shift();
  }
  function emit(key: string, price: number, tsUs?: number) {
    if (!(price > 0)) return;
    state.live = true; bump();
    try { onPrice(key, price, tsUs); } catch (e) {}
  }

  // ---------- LAZER ----------
  function lazerUrl() {
    if (RELAY) return RELAY;
    const base = ENDPOINTS[epIdx % ENDPOINTS.length];
    return TOKEN ? base + "?ACCESS_TOKEN=" + encodeURIComponent(TOKEN) : base;
  }
  function openLazer() {
    if (killed) return;
    state.source = "lazer"; state.label = "connecting Lazer…";
    const url = lazerUrl();
    try { ws = new WebSocket(url); } catch (e) { onLazerDown("ctor"); return; }

    ws.onopen = function () {
      lazerFails = 0; subCounter = 0; subChannel = {}; subFeeds = {};
      subscribeFeeds(feeds.map(function (f) { return f.lz; }), CHANNEL);
    };
    ws.onmessage = function (ev: MessageEvent) {
      let d: any; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.type === "error") { console.warn("[Lazer] error:", d); onLazerDown("error"); return; }
      if (d.type && d.type.indexOf("subscribed") === 0) {   // partial ACK: some feeds unsupported at this channel
        const ig = d.ignoredInvalidFeedIds || {}, unsup = ig.unsupportedChannels || [];
        if (unsup.length) {
          const slower = nextSlower(subChannel[d.subscriptionId] || CHANNEL);
          if (slower) subscribeFeeds(unsup, slower);
          else console.warn("[Lazer] feeds unsupported at slowest channel:", unsup);
        }
        return;
      }
      if (d.type === "subscriptionError") {                 // every feed in this sub unsupported at its channel
        const err = String(d.error || "");
        // An ENTITLEMENT failure (the token can't access these feeds — e.g. an expired/downgraded
        // burner) won't be fixed by a slower channel. Drop straight to the free Hermes feed instead
        // of looping on the dead Lazer subscription, which would otherwise strand the game on its sim.
        const entitlement = /insufficient access|not entitled|not accessible|allowed types/i.test(err);
        const sids = subFeeds[d.subscriptionId] || [], slower2 = nextSlower(subChannel[d.subscriptionId] || CHANNEL);
        if (!entitlement && sids.length && slower2) { subscribeFeeds(sids, slower2); return; }
        console.warn("[Lazer] subscriptionError → falling back to Hermes:", err);
        if (HERMES_FALLBACK) startHermes();
        return;
      }
      const p = d.parsed || (d.streamUpdated && d.streamUpdated.parsed) || null;
      const list = p && (p.priceFeeds || p.price_feeds);
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const pf = list[i], f = byLz[pf.priceFeedId != null ? pf.priceFeedId : pf.price_feed_id];
        if (!f) continue;
        const expo = (pf.exponent != null) ? pf.exponent : (f.expo != null ? f.expo : -8);
        emit(f.key, parseFloat(pf.price) * Math.pow(10, expo), p.timestampUs || p.timestamp_us);
      }
    };
    ws.onerror = function () { /* close fires next */ };
    ws.onclose = function () { ws = null; onLazerDown("close"); };
  }
  function onLazerDown(_why: string) {
    if (killed) return;
    lazerFails++; epIdx++;
    if (lazerFails >= ENDPOINTS.length + 1) {     // tried every endpoint at least once
      if (HERMES_FALLBACK) { startHermes(); return; }
    }
    state.live = false; state.label = "reconnecting Lazer…";
    setTimeout(openLazer, Math.min(4000, 400 * lazerFails));
  }

  // ---------- HERMES (free, no token — the STABLE default) -----------------
  // Hardened against pythdata.app/Lazer being unavailable:
  //   1) ONE multiplexed SSE for all feeds (not one connection per feed)
  //   2) a REST-poll backstop that fires only when the stream goes quiet
  //   3) a stall watchdog that force-reconnects a stream that's open-but-silent
  // Net effect: prices keep flowing on real Pyth even if SSE stalls/blocks,
  // so the games stay live instead of dropping to their internal sim.
  const byHx: Record<string, FeedSpec> = {};
  function normHx(s: string) { s = String(s || "").toLowerCase(); return s.indexOf("0x") === 0 ? s.slice(2) : s; }
  feeds.forEach(function (f) { if (f.hx) byHx[normHx(f.hx)] = f; });
  function hxQuery() { return feeds.filter(function (f) { return f.hx; }).map(function (f) { return "ids[]=" + f.hx; }).join("&"); }
  let lastHermesMsg = 0, hermesEs: EventSource | null = null, hermesPoll: ReturnType<typeof setInterval> | null = null, hermesWatch: ReturnType<typeof setInterval> | null = null;
  function emitParsed(arr: any[]) {
    if (!arr || !arr.length) return;
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i], f = byHx[normHx(it.id)]; if (!f) continue;
      const pr = it.price; if (!pr || pr.price == null) continue;
      const expo = (pr.expo != null) ? pr.expo : (f.expo != null ? f.expo : -8);
      lastHermesMsg = now();
      emit(f.key, parseFloat(pr.price) * Math.pow(10, expo), pr.publish_time);
    }
  }
  function openHermesSSE() {
    if (killed) return;
    try { if (hermesEs) hermesEs.close(); } catch (e) {}
    try {
      hermesEs = new EventSource(HERMES_SSE + "?" + hxQuery() + "&parsed=true");
      hermesEs.onmessage = function (e: MessageEvent) { try { emitParsed(JSON.parse(e.data).parsed); } catch (_) {} };
      hermesEs.onerror = function () {};   // browser auto-reconnects; watchdog covers silent stalls
    } catch (e) {}
  }
  function hermesPollOnce() {
    if (killed || now() - lastHermesMsg < 1200) return;   // stream healthy → don't poll
    try {
      fetch(HERMES_REST + "?" + hxQuery() + "&parsed=true")
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.parsed) emitParsed(d.parsed); })
        .catch(function () {});
    } catch (e) {}
  }
  function startHermes() {
    if (killed || usingHermes) return;
    usingHermes = true; state.source = "hermes"; state.label = "Pyth Hermes (no token)";
    openHermesSSE();
    hermesPoll  = setInterval(hermesPollOnce, 600);
    hermesWatch = setInterval(function () { if (!killed && now() - lastHermesMsg > 6000) openHermesSSE(); }, 3000);
  }

  // ---------- status heartbeat ----------
  const statusTimer = setInterval(function () {
    const t = now();
    while (ticks.length && t - ticks[0] > 1000) ticks.shift();
    state.rate = ticks.length;
    state.live = ticks.length > 0;
    if (state.live) {
      if (state.source === "lazer")
        state.label = "Pyth Lazer · " + CHANNEL.replace("fixed_rate@", "") + " · " + state.rate + "/s";
      else if (state.source === "hermes")
        state.label = "Pyth Hermes · " + state.rate + "/s";
    } else if (state.source === "lazer") {
      state.label = "Lazer connecting…";
    }
    try { onStatus(state); } catch (e) {}
  }, 250);

  // ---------- start ----------
  if (TOKEN || RELAY) openLazer();
  else if (HERMES_FALLBACK) startHermes();
  else { state.label = "no feed configured"; }

  return {
    state: state,
    stop: function () {
      killed = true; clearInterval(statusTimer); clearInterval(hermesPoll!); clearInterval(hermesWatch!);
      try { if (ws) ws.close(); } catch (e) {}
      try { if (hermesEs) hermesEs.close(); } catch (e) {}
    }
  };
}

export function config() { return { hasToken: !!TOKEN, hasRelay: !!RELAY, channel: CHANNEL }; }
