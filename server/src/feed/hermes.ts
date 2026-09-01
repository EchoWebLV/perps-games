import { FEED_SYMBOLS } from "./symbols.js";
import type { PriceFeed, PriceTick } from "./types.js";

const HERMES_BASE = "https://hermes.pyth.network/v2/updates/price";
const HERMES_LATEST = `${HERMES_BASE}/latest`;
const HERMES_STREAM = `${HERMES_BASE}/stream`;

// Pyth price-feed ids come from the one symbol table (server/src/feed/symbols.ts) — adding an
// asset is adding a row there, not editing this file.
const FEED_IDS: Record<string, string> = Object.fromEntries(
  Object.entries(FEED_SYMBOLS).map(([k, v]) => [k, v.hermesId]),
);

type Parsed = { id: string; price: { price: string; expo: number; publish_time: number } };

export interface HermesOpts {
  assets: string[];
  pollMs?: number;        // REST backstop interval, default 1000
  staleMs?: number;       // HALT threshold: wall-clock since the last NEWER price, default 6000
  streamQuietMs?: number; // run the REST backstop only when the stream's been silent this long, default 2000
  reconnectMs?: number;   // SSE reconnect backoff, default 1000
  fetchImpl?: typeof fetch; // injectable for tests
  now?: () => number;       // injectable wall clock (ms) for tests
  /** Pyth Terminal key. Omit to read PYTH_API_KEY. Pass "" to force unauthenticated (tests). */
  accessToken?: string;
}

/**
 * Server price feed. PRIMARY source is the Hermes SSE stream (sub-second price values — same stream
 * the client's graph rides, so the server "mark" the client settles against now updates sub-second,
 * making the displayed × both smooth AND equal to the settle). A REST /latest poll is a BACKSTOP that
 * only fires while the stream is silent (startup gap, dropped connection), so the feed degrades to the
 * old ~1Hz behaviour rather than failing. Health is advance-based (time since a NEWER publish_time),
 * decoupled from the public endpoint's benign 2–5s publish lag.
 */
export function makeHermesFeed(opts: HermesOpts): PriceFeed & { poll(): Promise<void> } {
  const pollMs = opts.pollMs ?? 1000;
  const staleMs = opts.staleMs ?? 6000;
  const streamQuietMs = opts.streamQuietMs ?? 2000;
  const reconnectMs = opts.reconnectMs ?? 1000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? (() => Date.now());
  const accessToken = opts.accessToken !== undefined ? opts.accessToken : (process.env.PYTH_API_KEY ?? "");

  function authorize(url: string): { url: string; headers: Record<string, string> } {
    if (!accessToken) return { url, headers: {} };
    const sep = url.includes("?") ? "&" : "?";
    return {
      url: `${url}${sep}ACCESS_TOKEN=${encodeURIComponent(accessToken)}`,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
  }

  const last: Record<string, PriceTick> = {};
  const lastAdvanceMs: Record<string, number> = {}; // wall time we last saw a NEWER publish_time
  let lastStreamMs = 0;                              // wall time of the last SSE message
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;

  const query = () => opts.assets.filter((a) => FEED_IDS[a]).map((a) => `ids[]=${FEED_IDS[a]}`).join("&");

  // One price update (shared by the stream + the REST backstop). Updates the latest tick on every
  // message (so the price value tracks sub-second); bumps the freshness clock only on a NEWER ts.
  function ingest(parsed: Parsed[] | undefined): void {
    for (const p of parsed ?? []) {
      const asset = opts.assets.find((a) => FEED_IDS[a] === p.id || FEED_IDS[a] === p.id.replace(/^0x/, ""));
      if (!asset) continue;
      const price = parseFloat(p.price.price) * Math.pow(10, p.price.expo);
      const tsUs = p.price.publish_time * 1_000_000; // publish_time is whole seconds
      if (!Number.isFinite(price) || !(price > 0)) continue;
      const prev = last[asset];
      if (prev && tsUs < prev.tsUs) continue;                 // out-of-order: ignore
      if (!prev || tsUs > prev.tsUs) lastAdvanceMs[asset] = now(); // a genuinely newer price → feed is alive
      last[asset] = { price, tsUs };                          // freshest value (even within the same second)
    }
  }

  async function tickOnce(): Promise<void> {
    const req = authorize(`${HERMES_LATEST}?${query()}&parsed=true`);
    const res = await doFetch(req.url, { headers: req.headers });
    if (!res.ok) return;
    const json = (await res.json()) as { parsed?: Parsed[] };
    ingest(json.parsed);
  }

  async function streamLoop(): Promise<void> {
    while (running) {
      try {
        abort = new AbortController();
        const req = authorize(`${HERMES_STREAM}?${query()}&parsed=true`);
        const res = await doFetch(req.url, {
          signal: abort.signal,
          headers: { accept: "text/event-stream", ...req.headers },
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (running) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n\n")) >= 0) {           // SSE events are separated by a blank line
            const evt = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            for (const line of evt.split("\n")) {
              if (!line.startsWith("data:")) continue;          // skip comments / keep-alives
              try {
                const json = JSON.parse(line.slice(5).trim()) as { parsed?: Parsed[] };
                ingest(json.parsed);
                lastStreamMs = now();
              } catch { /* partial / non-JSON keep-alive */ }
            }
          }
        }
      } catch { /* connection dropped or refused — fall through to reconnect */ }
      if (!running) break;
      await new Promise<void>((r) => { reconnectTimer = setTimeout(r, reconnectMs); });
    }
  }

  return {
    current(asset) {
      const t = last[asset];
      if (!t) throw new Error(`no tick for ${asset}`);
      return t;
    },
    healthy(asset) {
      const adv = lastAdvanceMs[asset];
      if (adv === undefined) return false;
      return now() - adv < staleMs; // fresh iff a NEWER price landed within staleMs (wall clock)
    },
    start() {
      running = true;
      void tickOnce().catch(() => {}); // instant first fill
      void streamLoop();               // sub-second SSE primary
      // REST backstop: only polls while the stream is silent (startup / drop), so it's a no-op when SSE is healthy
      timer = setInterval(() => {
        if (now() - lastStreamMs > streamQuietMs) void tickOnce().catch(() => {});
      }, pollMs);
    },
    stop() {
      running = false;
      abort?.abort();
      if (timer) clearInterval(timer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    },
    poll: tickOnce, // exposed for deterministic tests; the interval/stream drive it in production
  };
}
