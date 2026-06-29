import { PublicKey } from "@solana/web3.js";
import { CHAIN } from "./chain/config";
import { createDevKeypairPort } from "./chain/dev-keypair-port";
import { portToAnchorWallet } from "./chain/anchor-wallet";
import { createChainRound, type SettledRound } from "./chain/chain-round";
import { createPriceSource } from "./core/price-source";
import { connectFeed } from "./core/feed";
import { RoundEngine } from "./core/round";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const setText = (id: string, t: string) => { $(id).textContent = t; };
const usd = (lamports: bigint) => (Number(lamports) / 10 ** CHAIN.USDC_DECIMALS).toFixed(2);

const port = createDevKeypairPort();
let chain: ReturnType<typeof createChainRound> | null = null;
const engine = new RoundEngine();
const MAXSEC = 60;
let roundStartMs = 0;
let delegated = false;
let busy = false;
let liveDir: 1 | -1 = 1;
let liveLev = 100;
let polling = false;

// Single place a settlement (close, terminal-first flip/lever, OR the native crank) lands in the HUD.
function finalizeSettled(o: { outcome: number; outcomeName: string; payout: bigint }) {
  if (engine.getPhase() === "live") engine.cashout(priceSource.price(), Date.now()); // freeze the local visual
  setText("status", `${o.outcomeName.toUpperCase()} — payout ${usd(o.payout)} USDC.`);
  setText("mult", o.outcome === 2 ? "💥 liquidated" : `settled · +${usd(o.payout)} USDC`);
  void refreshBalance(true);
}

// BTC feed only (the on-chain program is BTC). priceSource.price() is a human float.
const priceSource = createPriceSource({
  connect: (onPrice) => {
    const h = connectFeed({ feeds: [{ key: "BTC", lz: 1, hx: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", expo: -8 }], onPrice: (k, v) => { if (k === "BTC") onPrice(v); } });
    return () => h.stop();
  },
});
addEventListener("pagehide", () => priceSource.stop());

async function refreshBalance(onEr = false) {
  if (!chain) return;
  try { setText("bal", usd(await chain.readPlayerBalance(onEr))); } catch { /* keep last */ }
}

async function init() {
  await port.connect();
  setText("addr", port.currentAddress() ?? "?");
  if (!CHAIN.TEST_USDC_MINT) { setText("status", "TEST_USDC_MINT not set in config.ts — run npm run chain:bootstrap first."); return; }
  chain = createChainRound({ wallet: portToAnchorWallet(port), mint: new PublicKey(CHAIN.TEST_USDC_MINT) });
  await refreshBalance(false);
  setText("status", "Fund the wallet (npm run chain:fund <addr> <mint>), then Start session.");
}

$("session").onclick = async () => {
  if (!chain || busy) return;
  busy = true;
  try {
    setText("status", "buying in…");
    const bal = await chain.readPlayerBalance(false);
    if (bal === 0n) await chain.buyIn(2_000_000); // 2 USDC buy-in from wallet test-USDC
    await chain.ensureRoundInited();
    setText("status", "delegating session to the ER (~8s)…");
    await chain.delegate();
    delegated = true;
    await refreshBalance(true);
    (($("go") as HTMLButtonElement).disabled = false);
    (($("end") as HTMLButtonElement).disabled = false);
    setText("status", "session live. Set dir/lev/stake and press GO.");
  } catch (e) { setText("status", `session failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

async function settle(kind: "cashout" | "expire") {
  if (!chain || busy || engine.getPhase() !== "live") return;
  busy = true;
  engine.cashout(priceSource.price(), Date.now()); // freeze the local visual
  setText("status", kind === "cashout" ? "closing on-chain…" : "time cap — closing…");
  try {
    const res: SettledRound = await chain.close();
    setText("status", `${res.outcomeName.toUpperCase()} — payout ${usd(res.payout)} USDC. balance ${usd(res.balance)}.`);
    setText("mult", res.outcome === 2 ? "💥 liquidated" : `settled · +${usd(res.payout)} USDC`);
    await refreshBalance(true);
  } catch (e) { setText("status", `close failed: ${(e as Error).message}`); }
  finally { busy = false; }
}

// the ONE GO handler: open if idle, cash out if live (branch on phase)
$("go").onclick = async () => {
  if (!chain || busy || !delegated) return;
  if (engine.getPhase() === "live") { void settle("cashout"); return; }
  busy = true;
  try {
    const dir = Number(($("dir") as HTMLSelectElement).value) as 1 | -1;
    const lev = Math.max(10, Math.min(2000, Math.round(Number(($("lev") as HTMLInputElement).value))));
    const stake = Math.round(Number(($("stake") as HTMLInputElement).value) * 10 ** CHAIN.USDC_DECIMALS);
    setText("status", "opening on-chain…");
    const opened = await chain.open(dir, lev, stake);
    roundStartMs = Date.now();
    liveDir = dir; liveLev = lev;
    engine.launch({ dir, lev, stake, entryRaw: opened.entryHuman, startMs: roundStartMs });
    (($("flip") as HTMLButtonElement).disabled = false);
    (($("levminus") as HTMLButtonElement).disabled = false);
    (($("levplus") as HTMLButtonElement).disabled = false);
    setText("status", `LIVE — entry $${opened.entryHuman.toFixed(2)}. arming crank…`);
    try {
      await chain.scheduleCrank();
      setText("status", `LIVE — entry $${opened.entryHuman.toFixed(2)}. crank armed — auto-settles. GO = cash out.`);
    } catch (e) {
      setText("status", `LIVE — entry $${opened.entryHuman.toFixed(2)}. ⚠ crank not armed (${(e as Error).message}); GO to cash out.`);
    }
  } catch (e) { setText("status", `open failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

$("flip").onclick = async () => {
  if (!chain || busy || !delegated || engine.getPhase() !== "live") return;
  busy = true;
  try {
    const newDir = (liveDir * -1) as 1 | -1;
    setText("status", `flipping → ${newDir === 1 ? "LONG" : "SHORT"}…`);
    const res = await chain.flip(newDir);
    if (res.settled) finalizeSettled(res);
    else {
      liveDir = newDir;
      engine.setDir(newDir, priceSource.price());
      ($("dir") as HTMLSelectElement).value = String(newDir);
      setText("status", `flipped → ${newDir === 1 ? "LONG" : "SHORT"} (gains banked).`);
    }
  } catch (e) { setText("status", `flip failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

async function changeLever(newLev: number) {
  if (!chain || busy || !delegated || engine.getPhase() !== "live") return;
  busy = true;
  try {
    setText("status", `leverage → ${newLev}×…`);
    const res = await chain.lever(newLev);
    if (res.settled) finalizeSettled(res);
    else {
      liveLev = newLev;
      engine.setLeverage(newLev, priceSource.price());
      ($("lev") as HTMLInputElement).value = String(newLev);
      setText("status", `leverage → ${newLev}× (gains banked).`);
    }
  } catch (e) { setText("status", `lever failed: ${(e as Error).message}`); }
  finally { busy = false; }
}
// Program clamps to RMIN=10..RMAX=2000; the UI doubles/halves within those bounds.
$("levplus").onclick = () => void changeLever(Math.min(2000, liveLev * 2));
$("levminus").onclick = () => void changeLever(Math.max(10, Math.floor(liveLev / 2)));

$("end").onclick = async () => {
  if (!chain || busy) return;
  busy = true;
  try {
    setText("status", "committing + undelegating…");
    await chain.commitAndUndelegate();
    delegated = false;
    (($("go") as HTMLButtonElement).disabled = true);
    (($("flip") as HTMLButtonElement).disabled = true);
    (($("levminus") as HTMLButtonElement).disabled = true);
    (($("levplus") as HTMLButtonElement).disabled = true);
    (($("withdraw") as HTMLButtonElement).disabled = false);
    await refreshBalance(false);
    setText("status", "session ended. You can Withdraw all.");
  } catch (e) { setText("status", `end failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

$("withdraw").onclick = async () => {
  if (!chain || busy) return;
  busy = true;
  try {
    const bal = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(bal));
    await refreshBalance(false);
    setText("status", `withdrew ${usd(bal)} USDC to the wallet ATA.`);
  } catch (e) { setText("status", `withdraw failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

// Poll on-chain Round ~1.5x/s so a crank/keeper settlement surfaces even if the player never clicks.
// setInterval (not rAF) because rAF is throttled to ~1.5fps in Claude Preview.
async function pollChain() {
  if (!chain || busy || !delegated || polling || engine.getPhase() !== "live") return;
  polling = true;
  try {
    const snap = await chain.readRound(true);
    if (snap && snap.status === 2) finalizeSettled(snap);
  } catch { /* transient RPC — keep last */ }
  finally { polling = false; }
}
setInterval(() => void pollChain(), 650);

// display loop: equity/payout from the local engine snapshot (no server mark in slice 1)
function frame() {
  if (engine.getPhase() === "live") {
    const price = priceSource.price();
    const now = Date.now();
    const snap = engine.snapshot(price, now);
    setText("mult", `×${Math.max(0, snap.equity).toFixed(2)}`);
    if ((now - roundStartMs) / 1000 >= MAXSEC) void settle("expire");
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

void init();
