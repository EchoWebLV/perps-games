import { PublicKey } from "@solana/web3.js";
import type { SolanaWalletPort } from "../core/solana-wallet";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import { createChainRound, maxPayoutBase, WalletUnfundedError, type ChainRound, type OpenedRound, type SettledRound, type ActionResult, type RoundSnap, type AssetSym } from "./chain-round";
import { createLeverSync } from "./lever-sync";

/** The settled shape main.ts needs to finalize a round in the HUD. */
export type SettledInfo = { outcome: number; outcomeName: string; payout: bigint };

/** Per-session till size, as a multiple of ONE round's worst-case payout. The till is a
 *  session bankroll (many rounds run off it); a multiple gives buffer so ordinary P&L
 *  swings don't strand it below the next round's max_payout lock. 3 (not 10) so a modest
 *  devnet pot accepts the DEFAULT bet (till = 3 × 23.75 × stake must fit the master pot);
 *  if a hot streak drains a till, the existing recover path re-slices on the next GO. */
export const SESSION_TILL_ROUNDS = 3;

/** Buy-in buffer, in bets: stage several bets' worth of the PLAYER's money per top-up so the
 *  heavy session rebuild (teardown + re-slice, ~8 txs) stays rare. Their money throughout —
 *  own PDA, withdrawable via cash-out — and the chip shows wallet+play as one number. */
export const SESSION_BUFFER_BETS = 5;

export interface GameSession {
  address(): string;
  delegated(): boolean;
  crankArmed(): boolean;
  balance(): bigint;
  init(): Promise<bigint>;
  /** Silent boot restore: true if the port had a persisted login (no login UI shown). */
  reconnect(): Promise<boolean>;
  refreshBalance(onEr?: boolean): Promise<bigint>;
  ensureSession(buyInBase: number, stakeBase: number): Promise<void>;
  // graceSecs / slFp / tpFp / refundFp: per-round risk knobs (Skull grace, Pink Rod SL/TP,
  // Flintstone liq-refund); 0 = off.
  open(asset: AssetSym, dir: 1 | -1, lev: number, stakeBase: number, durationSecs: number, liqFp: number, graceSecs?: number, slFp?: number, tpFp?: number, refundFp?: number): Promise<OpenedRound>;
  /** The owner wallet's native SOL (lamports) — the fundable balance the wallet panel shows. */
  walletSol(): Promise<bigint>;
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
  const port = opts.port ?? (opts.injectChain ? null : createDevKeypairPort());
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

  // End a live session: settle any open round, commit+undelegate, return the till to the
  // master pot. Shared by endSession (cash-out) and ensureSession's rebuild-on-short-ledger.
  async function teardownSession(c: ChainRound): Promise<void> {
    // Settle any still-open round FIRST — otherwise commit_and_undelegate lands an open
    // round (locked till) and sweep_till fails (till.locked != 0), stranding the slice in
    // the till and starving the master pot for the next session.
    try {
      const snap = await c.readRound(true);
      if (snap && snap.status === 1) await c.close();
    } catch (e) { console.warn("teardown: pre-settle skipped:", e); }
    await c.commitAndUndelegate();
    // Return the till (slice ± session P&L) to the master pot so it funds the next
    // session/player (self-smoothing). Now safe because the round is settled (lock released).
    try { await c.sweepTill(); } catch (e) { console.warn("sweep_till skipped:", e); }
    isDelegated = false;
  }

  // Re-adopt a still-live session (page reload / log-out→log-in mid-session): the L1 copy
  // of a delegated balance PDA is stale, and cash-out must know to undelegate first —
  // otherwise the chip shows old money and "Cash out" withdraws against a locked PDA.
  async function adoptAndRead(): Promise<void> {
    const c = need();
    const state = await c.delegationState().catch(() => "fresh" as const);
    isDelegated = state === "reuse";
    bal = await c.readPlayerBalance(isDelegated);
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
      await adoptAndRead();
      return bal;
    },

    async reconnect() {
      if (port?.reconnect) {
        const restored = await port.reconnect().catch(() => null);
        if (!restored) return false; // nothing persisted — caller decides when to show a login
      } else if (!chain) {
        return false;
      }
      chain ??= createChainRound({ wallet: portToAnchorWallet(port!), mint: opts.mint });
      await adoptAndRead();
      return true;
    },

    async refreshBalance(onEr = false) {
      bal = await need().readPlayerBalance(onEr);
      return bal;
    },

    async ensureSession(buyInBase, stakeBase) {
      const c = need();
      // A live session (already ours, or an adopted one — page reload / log-out→log-in):
      // ride it IF its ledger covers this bet. A delegated ledger can't be topped up from
      // the wallet (buy_in writes the L1 copy), so a short one is quietly ended + rebuilt
      // by the fresh path below (wallet top-up + re-slice). The player just sees GO.
      // Adoption gates on the L1 owners ("reuse") — the ER keeps serving a stale copy of
      // the Round after an undelegate, so a bare ER read is NOT a liveness signal (the
      // old End→GO HouseUndercapitalized wedge).
      let state: "reuse" | "fresh" | "busy" = "fresh";
      if (isDelegated) {
        state = "reuse";
      } else {
        state = await c.delegationState().catch(() => "fresh" as const);
      }
      if (state === "reuse") {
        isDelegated = true;
        bal = await c.readPlayerBalance(true);
        if (bal >= BigInt(stakeBase)) return; // the live session covers this bet — ride it
        await teardownSession(c);
      }
      // Torn mid-delegation: delegate() renders the friendly DelegateBusyError (don't let
      // the fresh path's sliceFromPot hit the half-delegated till with a raw tx error).
      if (state === "busy") await c.delegate();
      // Fresh session: buy in if the play balance is empty, carve a bet-sized till, delegate.
      const onL1 = await c.readPlayerBalance(false);
      // Fail fast on an unfunded wallet BEFORE spending: sends go out with skipPreflight, so a
      // 0-SOL fee payer (a brand-new Privy embedded wallet) otherwise dies as a silent drop +
      // a 60s confirm hang. Player-actionable message; best-effort (a read failure skips it).
      // Top up whenever the play balance can't cover THIS bet (not only when it's empty) —
      // the player thinks in "my SOL", so GO quietly moves what the round needs from the
      // wallet instead of bouncing them to a funding screen mid-flow.
      const needsBuyIn = onL1 < BigInt(stakeBase);
      const funds = await c.walletFunds().catch(() => null);
      if (funds) {
        const FEE_FLOOR = 5_000_000n; // fees + ATA rent headroom (~0.005 SOL)
        const solNeeded = needsBuyIn && isWsol ? BigInt(buyInBase) + FEE_FLOOR : FEE_FLOOR;
        if (funds.sol < solNeeded)
          throw new WalletUnfundedError("Your wallet needs SOL first — open the wallet panel and send SOL to your address.");
        if (needsBuyIn && !isWsol && funds.stake < BigInt(buyInBase))
          throw new WalletUnfundedError("Not enough funds in your wallet for this bet — top up your wallet first.");
      }
      // Stage a BUFFER of bets, not just this one (see SESSION_BUFFER_BETS) — capped by what
      // the wallet can spare. The pre-flight above guarantees at least `buyInBase` is there.
      let topUp = Math.max(buyInBase, stakeBase * SESSION_BUFFER_BETS);
      if (funds) {
        const FEE_FLOOR = 5_000_000n;
        const spendable = isWsol ? (funds.sol > FEE_FLOOR ? funds.sol - FEE_FLOOR : 0n) : funds.stake;
        topUp = Math.max(buyInBase, Math.min(topUp, Number(spendable)));
      }
      if (needsBuyIn) { if (isWsol) await c.wrapForBuyIn(topUp); await c.buyIn(topUp); }
      const fundedL1 = onL1 + (needsBuyIn ? BigInt(topUp) : 0n); // what the ER clone must show
      await c.ensureRoundInited();
      // Self-heal: reclaim any leftover (undelegated) till from a previous session whose
      // sweep was missed — e.g. an RPC failure at cash-out. Strands otherwise quietly
      // starve the master pot until every new session sees "Tables are full".
      try { await c.sweepTill(); } catch { /* no till to sweep */ }
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
      // The ER can serve a STALE copy of the player ledger right after delegation (same
      // stale-clone behavior as the Round after undelegate) — a bare read here returned 0
      // for a funded player and GO bounced with "Not enough SOL" (live-hit). Poll briefly
      // for the clone to land, then fall back to the L1 accounting we just performed.
      bal = await c.readPlayerBalance(true);
      for (let i = 0; i < 5 && bal < fundedL1; i++) {
        await new Promise((r) => setTimeout(r, 300));
        bal = await c.readPlayerBalance(true).catch(() => bal);
      }
      if (bal < fundedL1) bal = fundedL1;
    },

    async walletSol() {
      return (await need().walletFunds()).sol;
    },

    async open(asset, dir, lev, stakeBase, durationSecs, liqFp, graceSecs = 0, slFp = 0, tpFp = 0, refundFp = 0) {
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
      const opened = await c.open(asset, dir, lev, stakeBase, durationSecs, liqFp, graceSecs, slFp, tpFp, refundFp);
      armed = false;
      // Size the crank to THIS round: 1s ticks for the round's full duration + settle margin.
      // A fixed 70-tick schedule let a 90s Heavy-Load round outlive its own crank (the 90s
      // deadline was never observed on-chain and the round hung open) — live-found on devnet.
      try { await c.scheduleCrank({ iterations: durationSecs + 10 }); armed = true; } catch { armed = false; }
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
      await teardownSession(c);
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
      // Sign out: disconnect the wallet (for Privy this clears the auth session, so the next
      // init() shows the login modal — enabling account switch) and drop the local session so
      // init() reconnects fresh. Any live ER session persists on-chain (settle/reclaim via the
      // wallet panel); no on-chain state is touched here.
      try { await port?.disconnect(); } catch (e) { console.warn("wallet disconnect failed:", e); }
      chain = opts.injectChain ?? null;
      isDelegated = false;
      armed = false;
      bal = 0n;
    },
  };
}
