import type { Api, Asset, CloseResult, Dir } from "./api";
import type { KvStore } from "./identity";
import type { EvmWalletPort } from "../evm/wallet-port";
import { browserStore } from "./identity";
import { createRoundSync, type Clock, type RoundSync } from "./round-sync";

/**
 * The money loop's server-authoritative session — the Robinhood Chain rail's replacement for the
 * MagicBlock ER `GameSession`. Everything that used to be a signed on-chain transaction is now a
 * `/v1` call: the server holds the ledger (in CENTS), stamps the entry/exit prices from its own
 * feed, and settles. The wallet port is only ever used for two things — proving who the player is,
 * and moving real USDC in and out. It never signs a round.
 *
 * It keeps the ER session's method NAMES where the HUD already speaks them (`address`, `balance`,
 * `open`, `close`, `poll`, `refreshBalance`, `logout`) so the call sites in main.ts read the same,
 * plus four shims (`delegated`, `crankArmed`, `endSession`, `tableLimit`) that answer the questions
 * the HUD still asks about a lifecycle this rail simply does not have.
 */

/** Settlement reasons in the index order the HUD and the trade-history bridge already use. */
export const SETTLE_OUTCOMES = ["cashout", "cap", "liq", "time"] as const;

/**
 * Cents → USDC base units. The play ledger is denominated in cents (2 decimals); USDC on Robinhood
 * Chain has 6. The conversion lives HERE, at the only boundary where money actually leaves the
 * ledger for the chain — never inside the game code, which thinks in cents end to end.
 */
export const CENTS_TO_USDC_BASE = 10_000n;

/** What a settled round looks like to the HUD (identical to the ER session's `SettledInfo`). */
export interface SettledInfo {
  /** index into SETTLE_OUTCOMES — 2 is a liquidation, which the HUD renders as a wreck */
  outcome: number;
  outcomeName: string;
  /** payout in CENTS */
  payout: bigint;
  /** the human exit price the server settled against */
  exitHuman: number;
}

/** What an open round looks like to the HUD. */
export interface OpenedRound {
  roundId: string;
  /** the human entry price the server stamped */
  entryHuman: number;
  /** entry timestamp in whole SECONDS (the server stamps microseconds) */
  entryTs: number;
}

/** The server's live read on an open round: what the × should show right now. */
export interface LiveMark {
  equity: number;
  /** payout in CENTS at the current mark */
  payout: bigint;
  buffer: number;
}

export interface ServerSession {
  address(): string;
  /** EIP-191 personal_sign passthrough — the wallet binding's only use of the port. */
  signMessage(message: string): Promise<string>;
  /** cash balance in CENTS, as of the last authoritative read */
  balance(): bigint;

  /** Resume semantics: connect the wallet (may show a login UI). Resolves the address. */
  connect(): Promise<string>;
  /** Account-chooser semantics: drop the previous wallet FIRST so the login UI always shows. */
  loginFresh(): Promise<string>;
  /** Silent boot restore: true if a login was already persisted. Never shows a login UI. */
  reconnect(): Promise<boolean>;
  logout(): Promise<void>;

  /** Read the account: cache the cash balance and settle any round left dangling server-side.
   *  Runs AFTER the wallet bind, because /v1/me needs the session token that bind returns. */
  hydrate(): Promise<bigint>;
  refreshBalance(): Promise<bigint>;

  open(asset: Asset, dir: Dir, lev: number, stakeCents: number): Promise<OpenedRound>;
  noteLeverage(lev: number): void;
  noteFlip(dir: Dir): void;
  /** call once per frame: lets the lever coalescer sample the clock */
  pump(): void;
  /** Cash out. Resolves null when the server could not settle (halted feed / unreachable) — the
   *  round stays open and the poll below finishes it. */
  close(): Promise<SettledInfo | null>;
  poll(): Promise<{ settled: SettledInfo | null; live: LiveMark | null }>;

  /** the player's own on-chain USDC (base units), or null when unreadable */
  walletUsdc(): Promise<bigint | null>;
  /** send USDC from the player's wallet to the server's treasury; resolves the tx hash */
  deposit(amountCents: number): Promise<string>;
  /** reserve a cash-out to the BOUND wallet (the client never posts an address) */
  withdraw(amountCents: number): Promise<void>;

  // ── ER-lifecycle shims ────────────────────────────────────────────────────
  /** always false: there is no delegation on the server rail */
  delegated(): boolean;
  /** always true: the server's settler runs whether or not the app is open */
  crankArmed(): boolean;
  /** no-op: there is no session to tear down */
  endSession(): Promise<void>;
  /** always null: the house cap is enforced server-side, not surfaced as a client stepper cap */
  tableLimit(): Promise<bigint | null>;
}

function settledInfo(res: CloseResult): SettledInfo {
  const index = SETTLE_OUTCOMES.indexOf(res.outcome as (typeof SETTLE_OUTCOMES)[number]);
  return {
    outcome: index,
    outcomeName: res.outcome,
    payout: BigInt(Math.max(0, Math.round(res.payoutCoins))),
    exitHuman: res.exitRaw,
  };
}

export function createServerSession(deps: {
  api: Api;
  port: EvmWalletPort;
  store?: KvStore;
  clock?: Clock;
  /** test seam: inject a round-sync (the default composes one over `api`) */
  roundSync?: RoundSync;
}): ServerSession {
  const { api, port } = deps;
  const rounds = deps.roundSync ?? createRoundSync({
    api,
    clock: deps.clock ?? { now: () => Date.now() },
    store: deps.store ?? browserStore,
  });

  let cash = 0n;
  let treasury: string | null = null;

  /** The settlement path adopts the server's authoritative post-settle balance. */
  function adopt(res: CloseResult): SettledInfo {
    cash = BigInt(Math.round(res.balance));
    return settledInfo(res);
  }

  async function treasuryAddress(): Promise<string> {
    if (!treasury) treasury = (await api.depositAddress()).treasuryUsdcAta;
    return treasury;
  }

  return {
    address: () => port.currentAddress() ?? "",
    signMessage: (message) => port.signMessage(message),
    balance: () => cash,

    async connect() {
      const { address } = await port.connect();
      return address;
    },

    async loginFresh() {
      // A disconnect failure PROPAGATES: falling through to connect() would silently resume the
      // very session we just failed to clear — the "every sign-in lands in the same account" trap.
      await port.disconnect();
      cash = 0n;
      const { address } = await port.connect();
      return address;
    },

    async reconnect() {
      const restored = await port.reconnect().catch(() => null);
      return !!restored;
    },

    async logout() {
      try { await port.disconnect(); } finally { cash = 0n; }
    },

    async hydrate() {
      const me = await api.me();
      cash = BigInt(Math.round(me.balance));
      // A round left open by a crash / reload settles here, before the next GO can be blocked by it.
      await rounds.recover(me.openRoundId);
      if (me.openRoundId) cash = BigInt(Math.round((await api.me()).balance));
      return cash;
    },

    async refreshBalance() {
      cash = BigInt(Math.round((await api.me()).balance));
      return cash;
    },

    async open(asset, dir, lev, stakeCents) {
      let out = await rounds.open({ asset, dir, lev, stake: stakeCents });
      if (!out) {
        // A local round id is still on file. Ask the server what's true — it either settles the
        // straggler or tells us it's already gone — then open once more. This REPLACES the ER's
        // 6005 / table-rebuild ladder: there is no table to rebuild, only a round to reconcile.
        if (await rounds.reconcile() !== "cleared") throw new Error("round_already_open");
        out = await rounds.open({ asset, dir, lev, stake: stakeCents });
      }
      if (!out) throw new Error("round_already_open");
      // The server debited the stake inside /v1/round/open. Mirror it now so the cash chip is
      // honest the instant the round starts, instead of one /v1/me round-trip later.
      cash -= BigInt(Math.round(stakeCents));
      return {
        roundId: out.roundId,
        entryHuman: out.entryRaw,
        entryTs: Math.floor(out.entryTsUs / 1_000_000),
      };
    },

    noteLeverage: (lev) => rounds.noteLeverage(lev),
    noteFlip: (dir) => rounds.noteFlip(dir),
    pump: () => rounds.pump(),

    async close() {
      const res = await rounds.close("cashout");
      return res ? adopt(res) : null;
    },

    async poll() {
      const id = rounds.roundId();
      if (!id) return { settled: null, live: null };
      const mark = await api.markRound(id);
      if (mark.status === "settled") {
        // The server's settler got there first (auto cash-out / liq / expiry). Confirm it through
        // close, which replays the STORED settlement idempotently and carries the exit price the
        // mark does not — so the trade history records a real exit, not a guess.
        const res = await rounds.close("expire");
        return { settled: res ? adopt(res) : null, live: null };
      }
      return {
        settled: null,
        live: {
          equity: mark.equity,
          payout: BigInt(Math.max(0, Math.round(mark.payoutCoins))),
          buffer: mark.buffer,
        },
      };
    },

    walletUsdc: () => port.usdcBalance().catch(() => null),

    async deposit(amountCents) {
      return port.sendUsdcTransfer(await treasuryAddress(), BigInt(Math.round(amountCents)) * CENTS_TO_USDC_BASE);
    },

    async withdraw(amountCents) {
      await api.withdraw({ amountCents });
      // The reservation already debited the ledger — re-read rather than guess at the arithmetic.
      cash = BigInt(Math.round((await api.me()).balance));
    },

    delegated: () => false,
    crankArmed: () => true,
    endSession: async () => {},
    tableLimit: async () => null,
  };
}
