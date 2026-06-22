// Fetches REAL SOL price data from Binance public REST and caches it to sim/data/.
//   - calm.json : ~8000 consecutive 1s SOLUSDT klines (a low-realized-vol window)
//   - spike.json: the highest-vol 60-min window of 1m SOLUSDT klines over the
//                 trailing ~7 days (used to CALIBRATE the synthetic 1s spike path).
// No auth required. Run: node sim/fetch-data.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

async function klines(interval, limit, endTime) {
  const u = `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=${interval}&limit=${limit}${endTime ? `&endTime=${endTime}` : ""}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Binance ${interval} HTTP ${r.status}`);
  return r.json();
}

async function pagedBack(interval, pages) {
  let all = [];
  let end = Date.now();
  for (let i = 0; i < pages; i++) {
    const k = await klines(interval, 1000, end);
    if (!k.length) break;
    all = k.concat(all);
    end = k[0][0] - 1;
  }
  // dedupe by openTime
  const seen = new Set();
  return all.filter((c) => (seen.has(c[0]) ? false : (seen.add(c[0]), true)));
}

function perStepVol(closes) {
  let s = 0, n = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) { const r = Math.log(closes[i] / closes[i - 1]); s += r * r; n++; }
  }
  return Math.sqrt(s / n);
}

// ---- CALM: ~8000 consecutive 1s candles (recent low-vol window) ----
const calm1s = await pagedBack("1s", 8);
const calmCloses = calm1s.map((c) => +c[4]);
const calmMeta = {
  source: "Binance SOLUSDT 1s klines",
  candles: calm1s.length,
  fromIso: new Date(calm1s[0][0]).toISOString(),
  toIso: new Date(calm1s.at(-1)[0]).toISOString(),
  perSecVol: perStepVol(calmCloses),
};
writeFileSync(join(DIR, "calm.json"), JSON.stringify({ meta: calmMeta, closes: calmCloses }));
console.log("CALM", calmMeta);

// ---- SPIKE: highest-vol 60-min window of 1m candles over trailing ~7d ----
const mins = await pagedBack("1m", 11);
const mCloses = mins.map((c) => +c[4]);
let best = { vol: 0, i: 60 };
for (let i = 60; i < mCloses.length; i++) {
  let s = 0;
  for (let j = i - 59; j <= i; j++) { const r = Math.log(mCloses[j] / mCloses[j - 1]); s += r * r; }
  const v = Math.sqrt(s / 60);
  if (v > best.vol) best = { vol: v, i };
}
const wStart = best.i - 59;
const window = mins.slice(wStart, best.i + 1);
const winCloses = window.map((c) => +c[4]);
// biggest single 1m move in the window (real jump magnitude to inject)
let maxMove = 0;
for (let i = 1; i < winCloses.length; i++) maxMove = Math.max(maxMove, Math.abs(Math.log(winCloses[i] / winCloses[i - 1])));
const spikeMeta = {
  source: "Binance SOLUSDT 1m klines (highest-vol 60min window over trailing ~7d)",
  candles: window.length,
  fromIso: new Date(window[0][0]).toISOString(),
  toIso: new Date(window.at(-1)[0]).toISOString(),
  perMinVol: best.vol,
  maxSingleMinMovePct: maxMove * 100,
  medianAllWindowPerMinVol: (() => {
    const vols = [];
    for (let i = 60; i < mCloses.length; i++) { let s = 0; for (let j = i - 59; j <= i; j++) { const r = Math.log(mCloses[j] / mCloses[j - 1]); s += r * r; } vols.push(Math.sqrt(s / 60)); }
    vols.sort((a, b) => a - b); return vols[vols.length >> 1];
  })(),
};
writeFileSync(join(DIR, "spike.json"), JSON.stringify({ meta: spikeMeta, closes: winCloses }));
console.log("SPIKE", spikeMeta);
