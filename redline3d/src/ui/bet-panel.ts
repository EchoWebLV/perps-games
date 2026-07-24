// Fake prediction-market betting UI for the spectator-race preview (DEV-ONLY, used by
// src/race-preview.ts). Polymarket-style "WINNER" market in the game's neon-dark styling. Pure
// client sim: pari-mutuel pools seeded by rarity, fake bettors flowing in during MARKET OPEN,
// user stakes that move the odds, a bet slip, a collapsed strip while racing, and a settlement
// card on finish. Wallet is module-level: survives RACE AGAIN, resets on page reload. No chain,
// no server — this is a demo of the betting vision only.
import { onTap } from "./tap";
import { RAKE } from "../core/race-payout";

export interface BetCar { id: number; name: string; color: string }
export type BetPhase = "LOADING" | "MARKET" | "COUNTDOWN" | "RACING" | "FINISH";

export interface BetRenderCtx {
  phase: BetPhase;
  marketRemaining: number;   // seconds left in MARKET OPEN
  raceLeaderName: string | null; // current on-track leader (RACING)
}

export interface SettleResult { net: number; walletAfter: number; winnerMult: number }

export interface BetPanel {
  el: HTMLElement;
  setRoster(cars: BetCar[]): void;
  openMarket(seed: number, strengths: number[]): void;
  tick(dt: number): void;               // advance fake bettors (call during MARKET only)
  lock(): void;                         // freeze odds at market close
  settle(winnerId: number): SettleResult; // call once on entering FINISH; mutates wallet
  render(ctx: BetRenderCtx): void;
  onSkip(fn: () => void): void;
  onRaceAgain(fn: () => void): void;
  // verification-hook accessors
  wallet(): number;
  poolTotal(): number;
  probs(): number[];
  myBet(): number; // index of the car with the largest user stake, or -1
  dispose(): void;
}

const FLOW_INTERVAL = 0.8;  // seconds between fake-bettor pool inflows
const STAKES = [1, 5, 20];

// module-level wallet — persists across RACE AGAIN, resets only on page reload
let wallet = 100.0;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const STYLE_ID = "bet-panel-style";
// Two skins in one sheet. CLASSIC (base, unscoped) is the original dark-neon look. COMIC rules are
// scoped under `body.toon-ui` (toggled by toon.ts): thick near-black ink borders, chunky corners,
// HARD offset drop shadows (no blur), flat bright fills, heavy type. Same layout/info either way.
const CSS = `
.bp-root{position:fixed;inset:0;pointer-events:none;font-family:'Chakra Petch',ui-monospace,monospace;color:#eaf2ff;z-index:25;}
.bp-panel{position:absolute;right:14px;top:14px;width:340px;max-height:calc(100vh - 28px);overflow:auto;background:rgba(9,6,22,.82);border:1px solid rgba(122,90,220,.5);border-radius:14px;padding:14px;box-shadow:0 0 34px rgba(120,60,220,.3),inset 0 0 22px rgba(40,20,80,.4);backdrop-filter:blur(7px);pointer-events:auto;}
.bp-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;}
.bp-title{font-size:14px;font-weight:700;letter-spacing:.12em;color:#9ad7ff;text-transform:uppercase;}
.bp-timer{font-size:12px;font-weight:700;color:#ffd166;font-variant-numeric:tabular-nums;}
.bp-sub{display:flex;justify-content:space-between;font-size:11px;color:#8b95c9;margin-bottom:10px;letter-spacing:.04em;}
.bp-pool{color:#41d67f;font-weight:700;font-variant-numeric:tabular-nums;}
.bp-rows{display:flex;flex-direction:column;gap:4px;}
.bp-row{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);}
.bp-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 8px currentColor;}
.bp-nm{flex:1;min-width:0;}
.bp-nm b{display:block;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bp-nm span{font-size:9px;color:#8b95c9;font-variant-numeric:tabular-nums;letter-spacing:.02em;}
.bp-prob{text-align:right;font-size:12px;font-weight:700;color:#eaf2ff;font-variant-numeric:tabular-nums;min-width:60px;}
.bp-prob small{display:block;font-size:9px;font-weight:600;color:#ffd166;}
.bp-bet{cursor:pointer;font-family:inherit;font-size:11px;font-weight:700;letter-spacing:.04em;color:#04121a;background:linear-gradient(180deg,#4ff0ff,#27b7e7);border:none;border-radius:6px;padding:6px 9px;box-shadow:0 0 14px rgba(39,231,255,.4);-webkit-tap-highlight-color:transparent;user-select:none;}
.bp-bet:active{transform:translateY(1px);}
.bp-bet[disabled]{opacity:.35;filter:grayscale(.6);cursor:default;box-shadow:none;}
.bp-stakes{display:flex;gap:7px;margin:12px 0 8px;}
.bp-chip{flex:1;text-align:center;cursor:pointer;font-size:13px;font-weight:700;padding:8px 0;border-radius:8px;border:1px solid rgba(122,90,220,.45);background:rgba(255,255,255,.03);color:#c9d6ff;-webkit-tap-highlight-color:transparent;user-select:none;}
.bp-chip.sel{background:rgba(39,231,255,.16);border-color:#27e7ff;color:#eaf7ff;box-shadow:0 0 12px rgba(39,231,255,.35);}
.bp-slip{margin-top:6px;border-top:1px solid rgba(122,90,220,.3);padding-top:8px;display:flex;flex-direction:column;gap:4px;min-height:16px;}
.bp-slipline{font-size:11px;color:#c9d6ff;display:flex;justify-content:space-between;}
.bp-slipline em{color:#41d67f;font-style:normal;font-weight:700;}
.bp-empty{font-size:11px;color:#6b74a6;}
.bp-foot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;}
.bp-wallet{font-size:13px;font-weight:700;}
.bp-wallet span{color:#41d67f;font-variant-numeric:tabular-nums;}
.bp-skip{cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;letter-spacing:.1em;color:#c9d6ff;background:rgba(255,255,255,.05);border:1px solid rgba(122,90,220,.5);border-radius:8px;padding:8px 14px;-webkit-tap-highlight-color:transparent;user-select:none;}
.bp-strip{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:16px;align-items:center;background:rgba(9,6,22,.8);border:1px solid rgba(122,90,220,.45);border-radius:99px;padding:8px 18px;box-shadow:0 0 20px rgba(120,60,220,.25);font-size:12px;pointer-events:none;}
.bp-strip b{color:#ffd166;}
.bp-strip .lead{color:#27e7ff;}
.bp-settle{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(430px,86vw);text-align:center;background:rgba(9,6,22,.92);border:1px solid rgba(255,93,160,.55);border-radius:16px;padding:24px 22px;box-shadow:0 0 46px rgba(255,60,160,.35),inset 0 0 26px rgba(60,20,80,.5);pointer-events:auto;}
.bp-settle .flag{font-size:32px;}
.bp-settle .win{font-size:24px;font-weight:700;margin:4px 0 2px;}
.bp-settle .paid{font-size:13px;color:#ffd166;margin-bottom:12px;}
.bp-net{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;margin-bottom:2px;}
.bp-net.up{color:#41d67f;}.bp-net.down{color:#ff6b8b;}
.bp-walletbig{font-size:13px;color:#c9d6ff;margin-bottom:16px;}
.bp-again{cursor:pointer;font-family:inherit;font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#04121a;background:linear-gradient(180deg,#4ff0ff,#27b7e7);border:none;border-radius:10px;padding:11px 26px;box-shadow:0 0 22px rgba(39,231,255,.55);-webkit-tap-highlight-color:transparent;user-select:none;}
.bp-again:active{transform:translateY(1px);}

/* ── COMIC skin (active when body.toon-ui) ── */
body.toon-ui .bp-root{color:#f4f0ff;}
body.toon-ui .bp-panel{background:#241640;border:3px solid #0a0812;border-radius:16px;box-shadow:6px 6px 0 rgba(8,5,16,.9);backdrop-filter:none;}
body.toon-ui .bp-title{font-weight:800;letter-spacing:.10em;color:#ffe08a;}
body.toon-ui .bp-timer{font-weight:800;}
body.toon-ui .bp-sub{color:#b3a7d6;}
body.toon-ui .bp-pool{color:#3ff08a;font-weight:800;}
body.toon-ui .bp-rows{gap:5px;}
body.toon-ui .bp-row{border-radius:9px;background:#31204d;border:2px solid #0a0812;}
body.toon-ui .bp-dot{width:12px;height:12px;box-shadow:none;border:2px solid #0a0812;}
body.toon-ui .bp-nm b{font-weight:700;}
body.toon-ui .bp-nm span{color:#b3a7d6;}
body.toon-ui .bp-prob{font-weight:800;color:#f4f0ff;}
body.toon-ui .bp-prob small{font-weight:700;}
body.toon-ui .bp-bet{font-weight:800;background:#2de2e6;border:2px solid #0a0812;border-radius:8px;padding:6px 10px;box-shadow:2px 2px 0 rgba(8,5,16,.8);}
body.toon-ui .bp-bet:active{transform:translate(2px,2px);box-shadow:none;}
body.toon-ui .bp-bet[disabled]{opacity:.4;}
body.toon-ui .bp-chip{font-weight:800;border:2px solid #0a0812;border-radius:9px;background:#31204d;color:#e6ddff;box-shadow:2px 2px 0 rgba(8,5,16,.7);}
body.toon-ui .bp-chip.sel{background:#2de2e6;border-color:#0a0812;color:#04121a;box-shadow:2px 2px 0 rgba(8,5,16,.7);}
body.toon-ui .bp-slip{margin-top:8px;border-top:2px dashed #4a3670;}
body.toon-ui .bp-slipline{color:#e6ddff;}
body.toon-ui .bp-slipline em{color:#3ff08a;font-weight:800;}
body.toon-ui .bp-empty{color:#8a7db3;}
body.toon-ui .bp-wallet{font-weight:800;}
body.toon-ui .bp-wallet span{color:#3ff08a;}
body.toon-ui .bp-skip{font-weight:800;letter-spacing:.08em;color:#e6ddff;background:#31204d;border:2px solid #0a0812;border-radius:9px;box-shadow:2px 2px 0 rgba(8,5,16,.8);}
body.toon-ui .bp-skip:active{transform:translate(2px,2px);box-shadow:none;}
body.toon-ui .bp-strip{background:#241640;border:3px solid #0a0812;padding:8px 20px;box-shadow:4px 4px 0 rgba(8,5,16,.9);font-weight:700;}
body.toon-ui .bp-strip b{color:#ffd166;font-weight:800;}
body.toon-ui .bp-strip .lead{color:#2de2e6;font-weight:800;}
body.toon-ui .bp-settle{background:#241640;border:4px solid #0a0812;border-radius:18px;box-shadow:8px 8px 0 rgba(8,5,16,.9);}
body.toon-ui .bp-settle .flag{font-size:36px;}
body.toon-ui .bp-settle .win{font-weight:800;}
body.toon-ui .bp-settle .paid{font-weight:700;}
body.toon-ui .bp-net{font-size:32px;font-weight:800;}
body.toon-ui .bp-net.up{color:#3ff08a;}
body.toon-ui .bp-walletbig{color:#e6ddff;font-weight:700;}
body.toon-ui .bp-again{font-weight:800;letter-spacing:.10em;background:#2de2e6;border:3px solid #0a0812;border-radius:12px;box-shadow:4px 4px 0 rgba(8,5,16,.9);}
body.toon-ui .bp-again:active{transform:translate(3px,3px);box-shadow:1px 1px 0 rgba(8,5,16,.9);}
`;

export function createBetPanel(parent: HTMLElement = document.body): BetPanel {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style");
    st.id = STYLE_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }

  const root = document.createElement("div");
  root.className = "bp-root";
  root.innerHTML = `
    <div class="bp-panel">
      <div class="bp-head"><span class="bp-title">Winner Market</span><span class="bp-timer"></span></div>
      <div class="bp-sub"><span>Pari-mutuel · 5% rake</span><span>Pool <span class="bp-pool">$0</span></span></div>
      <div class="bp-rows"></div>
      <div class="bp-stakes"></div>
      <div class="bp-slip"></div>
      <div class="bp-foot">
        <span class="bp-wallet">Wallet <span>$100.00</span></span>
        <span class="bp-skip">SKIP →</span>
      </div>
    </div>
    <div class="bp-strip" style="display:none"></div>
    <div class="bp-settle" style="display:none">
      <div class="flag">🏁</div>
      <div class="win"></div>
      <div class="paid"></div>
      <div class="bp-net"></div>
      <div class="bp-walletbig"></div>
      <button class="bp-again" type="button">Race Again</button>
    </div>`;
  parent.appendChild(root);

  const panelEl = root.querySelector(".bp-panel") as HTMLElement;
  const timerEl = root.querySelector(".bp-timer") as HTMLElement;
  const poolEl = root.querySelector(".bp-pool") as HTMLElement;
  const rowsEl = root.querySelector(".bp-rows") as HTMLElement;
  const stakesEl = root.querySelector(".bp-stakes") as HTMLElement;
  const slipEl = root.querySelector(".bp-slip") as HTMLElement;
  const walletEl = root.querySelector(".bp-wallet span") as HTMLElement;
  const skipEl = root.querySelector(".bp-skip") as HTMLElement;
  const stripEl = root.querySelector(".bp-strip") as HTMLElement;
  const settleEl = root.querySelector(".bp-settle") as HTMLElement;
  const winEl = settleEl.querySelector(".win") as HTMLElement;
  const paidEl = settleEl.querySelector(".paid") as HTMLElement;
  const netEl = settleEl.querySelector(".bp-net") as HTMLElement;
  const walletBigEl = settleEl.querySelector(".bp-walletbig") as HTMLElement;
  const againBtn = settleEl.querySelector(".bp-again") as HTMLElement;

  // ---- market state ----
  let cars: BetCar[] = [];
  let pools: number[] = [];
  let userStake: number[] = [];
  let lockedMult: number[] = [];
  let locked = false;
  let rng = mulberry32(1);
  let flowAcc = 0;
  let selStake = 5;
  let lastSettle: { winnerId: number; net: number; winnerMult: number } | null = null;

  // per-car row element refs
  const rows: Array<{ row: HTMLElement; prob: HTMLElement; mult: HTMLElement; pool: HTMLElement; bet: HTMLButtonElement }> = [];

  const total = () => pools.reduce((a, b) => a + b, 0);
  const liveProbs = () => { const T = total() || 1; return pools.map((p) => p / T); };
  const liveMults = () => { const T = total(); return pools.map((p) => (p > 0 ? (T * (1 - RAKE)) / p : 0)); };

  function buildStakeChips() {
    stakesEl.innerHTML = "";
    for (const s of STAKES) {
      const chip = document.createElement("div");
      chip.className = "bp-chip" + (s === selStake ? " sel" : "");
      chip.textContent = `$${s}`;
      onTap(chip, () => { selStake = s; refreshStakeSel(); });
      stakesEl.appendChild(chip);
    }
  }
  function refreshStakeSel() {
    stakesEl.querySelectorAll(".bp-chip").forEach((c, i) => c.classList.toggle("sel", STAKES[i] === selStake));
  }

  function placeBet(carId: number) {
    if (locked || wallet < selStake) return;
    wallet -= selStake;
    pools[carId] += selStake;
    userStake[carId] += selStake;
  }

  return {
    el: root,
    setRoster(list) {
      cars = list;
      rowsEl.innerHTML = "";
      rows.length = 0;
      for (const c of cars) {
        const row = document.createElement("div");
        row.className = "bp-row";
        row.innerHTML = `
          <span class="bp-dot" style="background:${c.color};color:${c.color}"></span>
          <span class="bp-nm"><b>${c.name}</b><span class="bp-pool2"></span></span>
          <span class="bp-prob">0%<small>—</small></span>
          <button class="bp-bet" type="button">BET</button>`;
        rowsEl.appendChild(row);
        const bet = row.querySelector(".bp-bet") as HTMLButtonElement;
        onTap(bet, () => placeBet(c.id));
        rows.push({
          row,
          prob: row.querySelector(".bp-prob") as HTMLElement,
          mult: row.querySelector(".bp-prob small") as HTMLElement,
          pool: row.querySelector(".bp-pool2") as HTMLElement,
          bet,
        });
      }
      buildStakeChips();
    },
    openMarket(seed, strengths) {
      rng = mulberry32(seed);
      // seed pools by rarity strength^1.6 (favourite ~28-32%, longest shot ~4-6% across 8 outcomes)
      pools = strengths.map((s) => Math.pow(s, 1.6) * 18 + rng() * 8);
      userStake = cars.map(() => 0);
      lockedMult = [];
      locked = false;
      flowAcc = 0;
      lastSettle = null;
    },
    tick(dt) {
      if (locked) return;
      flowAcc += dt;
      while (flowAcc >= FLOW_INTERVAL) {
        flowAcc -= FLOW_INTERVAL;
        // fake bettor: pick a car weighted toward current favorites, add a stake
        const probs = liveProbs();
        let r = rng();
        let pick = 0;
        for (let i = 0; i < probs.length; i++) { r -= probs[i]; if (r <= 0) { pick = i; break; } }
        pools[pick] += 5 + rng() * 32;
      }
    },
    lock() {
      locked = true;
      lockedMult = liveMults();
    },
    settle(winnerId) {
      const mult = (lockedMult.length ? lockedMult : liveMults())[winnerId] || 0;
      const staked = userStake.reduce((a, b) => a + b, 0);
      const gross = userStake[winnerId] * mult;
      wallet += gross;
      const net = gross - staked;
      lastSettle = { winnerId, net, winnerMult: mult };
      return { net, walletAfter: wallet, winnerMult: mult };
    },
    render(ctx) {
      const showPanel = ctx.phase === "MARKET";
      panelEl.style.display = showPanel ? "block" : "none";
      stripEl.style.display = (ctx.phase === "COUNTDOWN" || ctx.phase === "RACING") ? "flex" : "none";
      settleEl.style.display = ctx.phase === "FINISH" ? "block" : "none";

      if (showPanel) {
        timerEl.textContent = `OPEN ${Math.max(0, Math.ceil(ctx.marketRemaining))}s`;
        poolEl.textContent = `$${total().toFixed(0)}`;
        const probs = liveProbs();
        const mults = liveMults();
        rows.forEach((r, i) => {
          r.prob.firstChild!.textContent = `${Math.round(probs[i] * 100)}% · ${Math.round(probs[i] * 100)}¢`;
          r.mult.textContent = `x${mults[i].toFixed(2)}`;
          r.pool.textContent = `$${pools[i].toFixed(0)} pool`;
          r.bet.disabled = wallet < selStake;
        });
        walletEl.textContent = `$${wallet.toFixed(2)}`;

        // bet slip
        slipEl.innerHTML = "";
        const any = userStake.some((s) => s > 0);
        if (!any) {
          const e = document.createElement("div");
          e.className = "bp-empty"; e.textContent = "No positions yet — pick a car.";
          slipEl.appendChild(e);
        } else {
          userStake.forEach((s, i) => {
            if (s <= 0) return;
            const pays = s * mults[i];
            const line = document.createElement("div");
            line.className = "bp-slipline";
            line.innerHTML = `<span>$${s.toFixed(0)} on ${cars[i].name}</span><em>→ $${pays.toFixed(2)}</em>`;
            slipEl.appendChild(line);
          });
        }
      }

      if (stripEl.style.display === "flex") {
        const mults = lockedMult.length ? lockedMult : liveMults();
        const myBets = userStake.map((s, i) => ({ s, i })).filter((b) => b.s > 0);
        const posTxt = myBets.length
          ? myBets.map((b) => `<b>$${b.s.toFixed(0)} ${cars[b.i].name}</b> → $${(b.s * mults[b.i]).toFixed(2)}`).join(" · ")
          : "<span style='color:#6b74a6'>no bet placed</span>";
        const lead = ctx.raceLeaderName ? `<span class="lead">LEADING ${ctx.raceLeaderName}</span>` : "";
        stripEl.innerHTML = `${posTxt} ${lead}`;
      }

      if (ctx.phase === "FINISH" && lastSettle) {
        const w = cars[lastSettle.winnerId];
        winEl.textContent = `${w.name} WINS`;
        winEl.style.color = w.color;
        paidEl.textContent = `market paid x${lastSettle.winnerMult.toFixed(2)}`;
        const up = lastSettle.net >= 0;
        netEl.textContent = `${up ? "+" : "−"}$${Math.abs(lastSettle.net).toFixed(2)}`;
        netEl.className = "bp-net " + (up ? "up" : "down");
        walletBigEl.textContent = `Wallet: $${wallet.toFixed(2)}`;
      }
    },
    onSkip(fn) { onTap(skipEl, () => fn()); },
    onRaceAgain(fn) { onTap(againBtn, () => fn()); },
    wallet: () => wallet,
    poolTotal: () => total(),
    probs: () => liveProbs(),
    myBet: () => { let bi = -1, bv = 0; userStake.forEach((s, i) => { if (s > bv) { bv = s; bi = i; } }); return bi; },
    dispose() { root.remove(); },
  };
}
