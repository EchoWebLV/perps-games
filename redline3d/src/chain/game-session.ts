import { PublicKey } from "@solana/web3.js";
import type { SolanaWalletPort } from "../core/solana-wallet";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet, type AnchorWalletLike } from "./anchor-wallet";
import { createChainRound, maxPayoutBase, roundKey, WalletUnfundedError, BankrollFullError, HIGHWAY_DURATION_SENTINEL, HIGHWAY_CRANK_ITERATIONS, isHighwayRound, type ChainRound, type OpenedRound, type SettledRound, type ActionResult, type RoundSnap, type AssetSym } from "./chain-round";
import { createLeverSync } from "./lever-sync";

/** The settled shape main.ts needs to finalize a round in the HUD. */
export type SettledInfo = Pick<SettledRound, "outcome" | "outcomeName" | "payout" | "exitHuman">;

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
  /** the connected session wallet as an anchor wallet, or null before connect — lets other
   *  chain clients (crate_roll VRF) sign with the SAME wallet the round loop uses. */
  anchorWallet(): AnchorWalletLike | null;
  /** sign a message with the connected wallet (server nonce-challenge binding). Throws if no wallet. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  delegated(): boolean;
  crankArmed(): boolean;
  balance(): bigint;
  liveRound(): RoundSnap | null;
  init(): Promise<bigint>;
  /** Sign-in with ACCOUNT-CHOOSER semantics (the identity gate's SIGN IN): any lingering
   *  wallet auth is cleared FIRST so connect() always shows the login UI. A persisted Privy
   *  session would otherwise silently resume the previous account — with no way to switch. */
  loginFresh(): Promise<bigint>;
  /** Silent boot restore: true if the port had a persisted login (no login UI shown). */
  reconnect(): Promise<boolean>;
  refreshBalance(onEr?: boolean): Promise<bigint>;
  ensureSession(buyInBase: number, stakeBase: number): Promise<void>;
  // graceSecs / slFp / tpFp / refundFp: per-round risk knobs (Skull grace, Pink Rod SL/TP,
  // Flintstone liq-refund); 0 = off.
  open(asset: AssetSym, dir: 1 | -1, lev: number, stakeBase: number, durationSecs: number, liqFp: number, graceSecs?: number, slFp?: number, tpFp?: number, refundFp?: number): Promise<OpenedRound>;
  /** The owner wallet's native SOL (lamports) — the fundable balance the wallet panel shows. */
  walletSol(): Promise<bigint>;
  /** Max stake (base units) the table can host for the NEXT round, or null when unknown
   *  (not connected / RPC down). Pot + this session's till: a drained till transparently
   *  rebuilds from the pot on GO, so the two together are what a bet can draw on. */
  tableLimit(): Promise<bigint | null>;
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
  coverageStore?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}): GameSession {
  const port = opts.port ?? (opts.injectChain ? null : createDevKeypairPort());
  let chain: ChainRound | null = opts.injectChain ?? null;
  let isDelegated = false;
  let armed = false;
  let bal = 0n;
  let liveSnap: RoundSnap | null = null;
  const memoryCoverage = new Map<string, number>();
  const coverageStore = opts.coverageStore ?? {
    getItem: (key: string) => { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } },
    setItem: (key: string, value: string) => { try { globalThis.localStorage?.setItem(key, value); } catch { /* unavailable */ } },
    removeItem: (key: string) => { try { globalThis.localStorage?.removeItem(key); } catch { /* unavailable */ } },
  };
  // THIS round's stable identity (owner + deadline_ts — see roundKey). The ER router can serve the
  // PREVIOUS round's settled state for a while after a fresh open, so every settle consumer checks
  // its snap's key against this before treating the round as over. deadline_ts is immutable for the
  // round's life (flip/lever re-anchor entry_raw, so entry fields must NOT key it) and per-owner
  // rounds are serial, so it separates THIS round from the previous round's corpse. null = no round yet.
  let curKey: string | null = null;
  // The identity of a round a PRIOR open attempt (this same GO) opened but couldn't confirm —
  // captured so a retry ADOPTS it instead of the stale-round reconcile settling our own fresh
  // round (see open()). null = nothing uncertain to adopt.
  let pendingOpenKey: string | null = null;
  // owner address for round-key scoping; stable per session (all round reads are our own PDA).
  const ownerId = () => opts.injectAddress ?? port?.currentAddress() ?? "";
  // The stake wrap/unwrap (native SOL ⇄ wSOL) only applies to the canonical wSOL mint; for
  // any other stake mint (e.g. a devnet test token) the token is held directly, no wrap.
  const isWsol = opts.mint.toBase58() === "So11111111111111111111111111111111111111112";

  function need(): ChainRound {
    if (!chain) throw new Error("game_session_not_initialized");
    return chain;
  }

  const coverageKey = (round: { deadlineTs: number }) => `redline.highway.crank.v1:${roundKey(round, ownerId())}`;

  function coverageUntil(round: { deadlineTs: number }): number {
    const key = coverageKey(round);
    const persisted = Number(coverageStore.getItem(key) ?? 0);
    return Math.max(memoryCoverage.get(key) ?? 0, Number.isFinite(persisted) ? persisted : 0);
  }

  function recordCoverage(round: { deadlineTs: number }, untilMs: number): void {
    const key = coverageKey(round);
    memoryCoverage.set(key, untilMs);
    coverageStore.setItem(key, String(untilMs));
  }

  async function armCrank(c: ChainRound, durationSecs: number, round: { deadlineTs: number }): Promise<void> {
    armed = false;
    if (durationSecs === HIGHWAY_DURATION_SENTINEL && coverageUntil(round) > Date.now()) {
      armed = true;
      return;
    }
    const iterations = durationSecs === HIGHWAY_DURATION_SENTINEL
      ? HIGHWAY_CRANK_ITERATIONS
      : durationSecs + 10;
    try {
      await c.scheduleCrank({ iterations });
      armed = true;
      if (durationSecs === HIGHWAY_DURATION_SENTINEL) {
        recordCoverage(round, Date.now() + HIGHWAY_CRANK_ITERATIONS * 1000);
      }
    } catch {
      armed = false;
    }
  }

  function openedSnap(opened: OpenedRound, dir: 1 | -1, lev: number): RoundSnap {
    return {
      status: 1, outcome: 0, outcomeName: "cashout", payout: 0n, banked: 0n,
      dir, lev, entryRaw: opened.entryRaw, entryExpo: opened.entryExpo,
      entryHuman: opened.entryHuman, entryTs: opened.entryTs ?? 0,
      exitRaw: 0n, exitHuman: 0, deadlineTs: opened.deadlineTs,
    };
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
    liveSnap = null;
  }

  // Re-adopt a still-live session (page reload / log-out→log-in mid-session): the L1 copy
  // of a delegated balance PDA is stale, and cash-out must know to undelegate first —
  // otherwise the chip shows old money and "Cash out" withdraws against a locked PDA.
  async function adoptAndRead(): Promise<void> {
    const c = need();
    armed = false;
    const state = await c.delegationState().catch(() => "fresh" as const);
    isDelegated = state === "reuse";
    bal = await c.readPlayerBalance(isDelegated);
    if (isDelegated) {
      // adopting a live session mid-round: pick up the round's identity so the corpse
      // guard below keys on it (a still-open round is the only trustworthy source)
      const snap = await c.readRound(true).catch(() => null);
      if (snap && snap.status === 1) {
        curKey = roundKey(snap, ownerId());
        liveSnap = snap;
        if (isHighwayRound(snap)) await armCrank(c, HIGHWAY_DURATION_SENTINEL, snap);
      } else {
        liveSnap = null;
      }
    } else {
      liveSnap = null;
    }
  }

  // Background coalesced on-chain leverage: instant local feel lives in main.ts; this trails to latest.
  const leverSync = createLeverSync({
    send: async (lev) => {
      if (!chain) return;
      const res = await chain.lever(lev);
      if (res.settled) {
        // ER reads have no cross-node read-after-write guarantee: a lever fired right
        // after open can fetch the PREVIOUS round's settled corpse. Only a settle carrying
        // THIS round's identity may end the round (phantom "Settled at ×…" live-hit).
        if (curKey && roundKey(res, ownerId()) !== curKey) { console.warn("[session] ignored stale settle (lever raced a fresh open)"); return; }
        liveSnap = null;
        opts.onSettled(res);
      } else {
        const fresh = await chain.readRound(true).catch(() => null);
        if (fresh?.status === 1) liveSnap = fresh;
      }
    },
  });

  // Connect the wallet + build the chain client (idempotent — a live chain is kept).
  async function connectChain(): Promise<void> {
    if (!chain) {
      await port!.connect();
      chain = createChainRound({ wallet: portToAnchorWallet(port!), mint: opts.mint });
    }
  }

  return {
    address: () => opts.injectAddress ?? port?.currentAddress() ?? "",
    anchorWallet: () => { try { return port?.currentAddress() ? portToAnchorWallet(port) : null; } catch { return null; } },
    signMessage: (message) => {
      if (!port) throw new Error("no_wallet");
      return port.signMessage(message);
    },
    delegated: () => isDelegated,
    crankArmed: () => armed,
    balance: () => bal,
    liveRound: () => liveSnap,

    async init() {
      await connectChain();
      await adoptAndRead();
      return bal;
    },

    async loginFresh() {
      // Account-chooser semantics: drop any lingering wallet auth BEFORE connecting, so
      // connect() opens the login UI instead of silently resuming the previous account.
      // A disconnect failure PROPAGATES — falling through to connect() would resume the
      // very session we just failed to clear (the "every sign-in lands in the same
      // account" trap this method exists to close).
      await port?.disconnect();
      chain = opts.injectChain ?? null;
      isDelegated = false;
      armed = false;
      bal = 0n;
      liveSnap = null;
      curKey = null; pendingOpenKey = null; // the old account's round identity must not gate the new one's settles
      await connectChain();
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
      // many rounds off this one till, and each round locks `max_payout`; a multiple gives
      // buffer so ordinary P&L swings don't strand it below the next round's lock. But the
      // multiple is a NICE-TO-HAVE — the true solvency line is ONE round's max payout. So
      // take what the pot can host (3, 2, or 1 rounds) instead of refusing a playable table,
      // and only refuse below 1 round — then NAME the table limit instead of "try again".
      const oneRound = maxPayoutBase(stakeBase);
      let rounds = SESSION_TILL_ROUNDS;
      const avail = await c.houseAvailable().catch(() => null);
      if (avail !== null) {
        const fit = avail / BigInt(oneRound); // floor
        if (fit < 1n) {
          // Largest stake whose 23.75x max payout the pot still covers, floored to the
          // 0.01-SOL bet step the UI uses. Below one step, the table is genuinely spent.
          const maxStakeSol = Math.floor((Number(avail) / 23.75 / 1e9) * 100) / 100;
          throw new BankrollFullError(maxStakeSol >= 0.01
            ? `Table limit right now is ${maxStakeSol.toFixed(2)} SOL — lower your bet to play.`
            : "The table's bankroll is spent — try again soon.");
        }
        rounds = Math.min(rounds, Number(fit));
      }
      await c.sliceFromPot(oneRound * rounds); // races still surface the program's own check below
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

    async tableLimit() {
      if (!chain) return null;
      try {
        // pot is NEVER delegated → L1 read is authoritative; the till lives wherever the
        // session does. An undelegated leftover till counts too — ensureSession sweeps it
        // into the pot before slicing, so a GO can draw on it.
        const pot = await chain.houseAvailable();
        const till = await chain.tillAvailable(isDelegated).catch(() => 0n);
        // invert settle::max_payout (floor(stake × 23.75)): the largest stake whose lock fits
        return ((pot + till) * 1_000_000n * 1_000_000n) / (25_000_000n * 950_000n);
      } catch {
        return null;
      }
    },

    async open(asset, dir, lev, stakeBase, durationSecs, liqFp, graceSecs = 0, slFp = 0, tpFp = 0, refundFp = 0) {
      const c = need();
      // Size the crank to THIS round: 1s ticks over the whole duration + settle margin. A fixed
      // 70-tick schedule let a 90s Heavy-Load round outlive its crank (live-found on devnet).
      // Reconcile a leftover OPEN round before starting a new one. After a page reload, a
      // log-out→log-in, or a missed auto-settle (crank), a prior round can still be open on-chain
      // while the client thinks it's idle — `open` would then reject it as RoundAlreadyOpen. Settle
      // that STALE round so a fresh one can start. BUT if the leftover round is the one a PRIOR
      // uncertain attempt of THIS open just opened (pendingOpenKey), ADOPT it — main retries an
      // open whose confirm merely flaked, and that retry must never settle our own fresh round.
      // Best-effort otherwise: a read/close failure still lets open() below surface a genuine block.
      try {
        const snap = await c.readRound(true);
        if (snap && snap.status === 1) {
          if (pendingOpenKey && roundKey(snap, ownerId()) === pendingOpenKey) {
            curKey = pendingOpenKey;
            pendingOpenKey = null;
            liveSnap = snap;
            await armCrank(c, durationSecs, snap); // the uncertain attempt threw before arming
            return { entryRaw: snap.entryRaw, entryExpo: snap.entryExpo, entryHuman: snap.entryHuman, entryTs: snap.entryTs, deadlineTs: snap.deadlineTs, feed: "" };
          }
          await c.close();
          bal = await c.readPlayerBalance(true);
        }
      } catch (e) { console.warn("open: stale-round reconcile skipped:", e); }
      let opened: OpenedRound;
      try {
        opened = await c.open(asset, dir, lev, stakeBase, durationSecs, liqFp, graceSecs, slFp, tpFp, refundFp);
      } catch (e) {
        // The open tx may have LANDED even though its confirmation failed (devnet transient).
        // Capture the just-opened round's identity so main's retry ADOPTS it above rather than the
        // reconcile settling it. Best-effort: if it isn't visible yet, we fall back to prior behavior.
        const snap = await c.readRound(true).catch(() => null);
        if (snap && snap.status === 1) pendingOpenKey = roundKey(snap, ownerId());
        throw e;
      }
      pendingOpenKey = null; // a confirmed open — nothing uncertain is left to adopt
      // Stamp the round's identity from a VERIFIED live read (status 1). open()'s own
      // post-send fetch can itself be the stale corpse — if the verified read disagrees,
      // its entry/deadline win (they come from the round that is actually running).
      let live: Awaited<ReturnType<typeof c.readRound>> = null;
      for (let i = 0; i < 3 && !live; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 250));
        const snap = await c.readRound(true).catch(() => null);
        if (snap && snap.status === 1) live = snap;
      }
      curKey = roundKey(live ?? opened, ownerId());
      if (live && roundKey(live, ownerId()) !== roundKey(opened, ownerId())) {
        opened = { entryRaw: live.entryRaw, entryExpo: live.entryExpo, entryHuman: live.entryHuman, entryTs: live.entryTs, deadlineTs: live.deadlineTs, feed: opened.feed };
      }
      liveSnap = live ?? openedSnap(opened, dir, lev);
      await armCrank(c, durationSecs, liveSnap);
      return opened;
    },

    noteLeverage(lev) {
      if (isDelegated) leverSync.submit(lev);
    },

    async flip(dir) {
      const res = await need().flip(dir);
      if (res.settled && curKey && roundKey(res, ownerId()) !== curKey) {
        // the flip landed but its fetch raced onto the previous round's corpse — re-read
        const fresh = await need().readRound(true).catch(() => null);
        if (fresh && fresh.status === 1) {
          liveSnap = fresh;
          return { settled: false as const, banked: fresh.banked, dir: fresh.dir, lev: fresh.lev, entryHuman: fresh.entryHuman };
        }
      }
      if (res.settled) liveSnap = null;
      else {
        const fresh = await need().readRound(true).catch(() => null);
        if (fresh?.status === 1) liveSnap = fresh;
      }
      return res;
    },

    async close() {
      const res = await need().close();
      bal = res.balance;
      liveSnap = null;
      return res;
    },

    async poll() {
      const snap = await need().readRound(true);
      // a settled snap from a PREVIOUS round (stale ER node) must not end THIS round
      if (snap && snap.status === 2 && curKey && roundKey(snap, ownerId()) !== curKey) return null;
      liveSnap = snap?.status === 1 ? snap : null;
      if (liveSnap && isHighwayRound(liveSnap) && coverageUntil(liveSnap) <= Date.now()) {
        await armCrank(need(), HIGHWAY_DURATION_SENTINEL, liveSnap);
      }
      return snap;
    },

    async endSession() {
      const c = need();
      await teardownSession(c);
      liveSnap = null;
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
      liveSnap = null;
    },
  };
}
