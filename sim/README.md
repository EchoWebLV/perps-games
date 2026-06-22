# House-economics Monte-Carlo (high-leverage perp settlement)

Faithful replay of the game's real settlement engine (`packages/engine/`) over real
SOL price paths, to measure HOUSE economics across leverage / player-model / market.

## Faithfulness
- Imports `equityOf` + `payoutOf` **directly** from `packages/engine/src/economics.ts`
  (the money math is provably identical to production).
- Replicates ONLY the `finalize` outcome->equity mapping (`liq=0`, `cap=CAP`,
  `cashout=equityOf`) and the settlement precedence (`liq -> cap -> time -> cashout`).
- **PER-TICK evaluation**: checks liq/cap/time at EVERY 1s tick. This models the planned
  autonomous settler and is the conservative choice for house risk. Production
  `settle.ts` today is *marks-only* (open/actions/exit), which is even MORE
  house-favorable (fewer barrier triggers).

## Data
- `node sim/fetch-data.mjs` — fetches & caches:
  - `data/calm.json`  : ~8000 real Binance SOLUSDT **1s** klines (low-vol window).
  - `data/spike.json` : the real highest-vol 60-min **1m** SOL window over trailing ~7d
    (used to CALIBRATE the synthetic 1s spike path — Binance 1s history only reaches
    back ~2h, so the real volatile day isn't available at 1s granularity).
- `paths.ts` builds: calm = real 1s replay; spike = synthetic 1s calibrated to the real
  spike window's realized vol + real-magnitude injected jump candles.

## Run
```
node sim/crosscheck.ts                 # driftless martingale cross-check (validates harness)
ROUNDS=150000 SEQS=200 node sim/highlev-sim.ts   # full matrix -> JSON on stdout
```
Matrix: leverage {100,500,1000,2000} x model {independent,net-directional} x
market {calm,spike}. Starting house bankroll = 500 x MAX_STAKE = $25,000.

## Cross-check
`crosscheck.ts` runs the independent + ride-to-barrier sub-population on a driftless
arithmetic price walk and Richardson-extrapolates to the continuous limit, confirming
P(cap) ~= (1-LIQ)/(CAP-LIQ) = 3.226% and houseEv ~= +23.38%. A tick-discretized barrier
sim overshoots barriers by O(h); the extrapolation removes that finite-step bias.
