import { PublicKey } from "@solana/web3.js";
import type { SolanaWalletPort } from "../core/solana-wallet";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import { createChainRound, maxPayoutBase, type ChainRound, type OpenedRound, type SettledRound, type ActionResult, type RoundSnap, type AssetSym } from "./chain-round";
import { createLeverSync } from "./lever-sync";

/** The settled shape main.ts needs to finalize a round in the HUD. */
export type SettledInfo = { outcome: number; outcomeName: string; payout: bigint };

/** Per-session till size, as a multiple of ONE round's worst-case payout. The till is a
 *  session bankroll (many rounds run off it); a multiple gives buffer so ordinary P&L
 *  swings don't strand it below the next round's max_payout lock. */
export const SESSION_TILL_ROUNDS = 10;

export interface GameSession {
  address(): string;
  delegated(): boolean;
  crankArmed(): boolean;
  balance(): bigint;
  init(): Promise<bigint>;
  refreshBalance(onEr?: boolean): Promise<bigint>;
  ensureSession(buyInBase: number, stakeBase: number): Promise<void>;
  // graceSecs / slFp / tpFp: per-round risk knobs (Skull grace, Pink Rod SL/TP); 0 = off.
  open(asset: AssetSym, dir: 1 | -1, lev: number, stakeBase: number, durationSecs: number, liqFp: number, graceSecs?: number, slFp?: number, tpFp?: number): Promise<OpenedRound>;
  noteLeverage(lev: number): void;
  flip(dir: 1 | -1): Promise<ActionResult>;
  close(): Promise<SettledRound>;
  poll(): Promise<RoundSnap | null>;
  endSession(): Promise<void>;
  withdraw(): Promise<void>;
  logout(): Promise<void>;
}

/**
 * On-chain ER-session controller wrapping chain-round + a single-flight lever sync.
 * `injectChain`/`injectAddress` are test seams; in the app they default to a dev-keypair port.
 */
export function createGameSession(opts: {
  mint: PublicKey;
  onSettled: (info: SettledInfo) => void;
  port?: SolanaWalletPort;            // the on-chain signer (defaults to dev-keypair)
  injectChain?: ChainRound;
  injectAddress?: string;
}): GameSession {
  const port = opts.injectChain ? null : (opts.port ?? createDevKeypairPort());
  let chain: ChainRound | null = opts.injectChain ?? null;
  let isDelegated = false;
  let armed = false;
  let bal = 0n;
  // The stake wrap/unwrap (native SOL ⇄ wSOL) only applies to the canonical wSOL mint; for
  // any other stake mint (e.g. a devnet test token) the token is held directly, no wrap.
  const isWsol = opts.mint.toBase58() === "So11111111111111111111111111111111111111112";

  function need(): ChainRound {
    if (!chain) throw new Error("game_session_not_initialized");
    return chain;
  }

  // Background coalesced on-chain leverage: instant local feel lives in main.ts; this trails to latest.
  const leverSync = createLeverSync({
    send: async (lev) => {
      if (!chain) return;
      const res = await chain.lever(lev);
      if (res.settled) opts.onSettled(res);
    },
  });

  return {
    address: () => opts.injectAddress ?? port?.currentAddress() ?? "",
    delegated: () => isDelegated,
    crankArmed: () => armed,
    balance: () => bal,

    async init() {
      if (!chain) {
        await port!.connect();
        chain = createChainRound({ wallet: portToAnchorWallet(port!), mint: opts.mint });
      }
      bal = await chain.readPlayerBalance(false);
      return bal;
    },

    async refreshBalance(onEr = false) {
      bal = await need().readPlayerBalance(onEr);
      return bal;
    },

    async ensureSession(buyInBase, stakeBase) {
      const c = need();
      if (isDelegated) return;
      // Adopt an already-delegated session (page reload / log-out→log-in mid-session): the
      // Round lives on the ER ONLY while delegated, so a successful ER read means a prior
      // session is still live. Reuse it — the till is already sliced, so do NOT buy in or
      // re-slice (the delegated till is program-locked; re-slicing fails and can drain the
      // pot). open() settles any leftover open round before starting the new one.
      const existing = await c.readRound(true).catch(() => null);
      if (existing) { isDelegated = true; bal = await c.readPlayerBalance(true); return; }
      // Fresh session: buy in if the play balance is empty, carve a bet-sized till, delegate.
      const onL1 = await c.readPlayerBalance(false);
      if (onL1 === 0n) { if (isWsol) await c.wrapForBuyIn(buyInBase); await c.buyIn(buyInBase); }
      await c.ensureRoundInited();
      // Carve a SESSION-sized till off the master pot BEFORE delegating it. A session plays
      // many rounds off this one till, and each round locks `max_payout`; sizing the till to
      // exactly one max_payout leaves zero buffer, so a single player-favorable round strands
      // it below the next round's lock (HouseUndercapitalized) and the session can't continue.
      // Carve a healthy multiple so normal P&L swings never block round-to-round play. If it
      // does eventually drain, the player ends the session + presses GO to re-slice a fresh
      // till (main.ts surfaces that). Throws BankrollFullError if the pot can't cover it.
      await c.sliceFromPot(maxPayoutBase(stakeBase) * SESSION_TILL_ROUNDS);
      await c.delegate(); // hardened: reuses a stale-but-live same-wallet session, else throws DelegateBusyError
      isDelegated = true;
      bal = await c.readPlayerBalance(true);
    },

    async open(asset, dir, lev, stakeBase, durationSecs, liqFp, graceSecs = 0, slFp = 0, tpFp = 0) {
      const c = need();
      // Reconcile a leftover OPEN round before starting a new one. After a page reload,
      // a log-out→log-in, or a missed auto-settle (crank), a prior round can still be open
      // on-chain while the client thinks it's idle — `open` would then reject it as
      // RoundAlreadyOpen ("Couldn't start the round"). Settle the stale round first so a
      // fresh one can always start. Best-effort: if it can't be read/closed, open() below
      // still surfaces a genuine block.
      try {
        const snap = await c.readRound(true);
        if (snap && snap.status === 1) {
          await c.close();
          bal = await c.readPlayerBalance(true);
        }
      } catch (e) { console.warn("open: stale-round reconcile skipped:", e); }
      const opened = await c.open(asset, dir, lev, stakeBase, durationSecs, liqFp, graceSecs, slFp, tpFp);
      armed = false;
      try { await c.scheduleCrank(); armed = true; } catch { armed = false; }
      return opened;
    },

    noteLeverage(lev) {
      if (isDelegated) leverSync.submit(lev);
    },

    async flip(dir) {
      return need().flip(dir);
    },

    async close() {
      const res = await need().close();
      bal = res.balance;
      return res;
    },

    async poll() {
      return need().readRound(true);
    },

    async endSession() {
      const c = need();
      // Settle any still-open round FIRST — otherwise commit_and_undelegate lands an open
      // round (locked till) and sweep_till fails (till.locked != 0), stranding the slice in
      // the till and starving the master pot for the next session.
      try {
        const snap = await c.readRound(true);
        if (snap && snap.status === 1) await c.close();
      } catch (e) { console.warn("endSession: pre-settle skipped:", e); }
      await c.commitAndUndelegate();
      // Return the till (slice ± session P&L) to the master pot so it funds the next
      // session/player (self-smoothing). Now safe because the round is settled (lock released).
      try { await c.sweepTill(); } catch (e) { console.warn("sweep_till skipped:", e); }
      isDelegated = false;
      bal = await c.readPlayerBalance(false);
    },

    async withdraw() {
      const c = need();
      const b = await c.readPlayerBalance(false);
      await c.withdraw(Number(b));
      if (isWsol) await c.unwrapAll(); // wSOL → native SOL back in the wallet
      bal = await c.readPlayerBalance(false);
    },

    async logout() {
      // Sign out: drop the session so the next init() reconnects fresh. Any live ER session
      // persists on-chain (settle/reclaim via the wallet panel) — this is a UI sign-out only.
      chain = opts.injectChain ?? null;
      isDelegated = false;
      armed = false;
      bal = 0n;
    },
  };
}
