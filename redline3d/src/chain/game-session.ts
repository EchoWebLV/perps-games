import { PublicKey } from "@solana/web3.js";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import { createChainRound, type ChainRound, type OpenedRound, type SettledRound, type ActionResult, type RoundSnap, type AssetSym } from "./chain-round";
import { createLeverSync } from "./lever-sync";

/** The settled shape main.ts needs to finalize a round in the HUD. */
export type SettledInfo = { outcome: number; outcomeName: string; payout: bigint };

export interface GameSession {
  address(): string;
  delegated(): boolean;
  crankArmed(): boolean;
  balance(): bigint;
  init(): Promise<bigint>;
  refreshBalance(onEr?: boolean): Promise<bigint>;
  ensureSession(buyInBase: number): Promise<void>;
  open(asset: AssetSym, dir: 1 | -1, lev: number, stakeBase: number): Promise<OpenedRound>;
  noteLeverage(lev: number): void;
  flip(dir: 1 | -1): Promise<ActionResult>;
  close(): Promise<SettledRound>;
  poll(): Promise<RoundSnap | null>;
  endSession(): Promise<void>;
  withdraw(): Promise<void>;
}

/**
 * On-chain ER-session controller wrapping chain-round + a single-flight lever sync.
 * `injectChain`/`injectAddress` are test seams; in the app they default to a dev-keypair port.
 */
export function createGameSession(opts: {
  mint: PublicKey;
  onSettled: (info: SettledInfo) => void;
  injectChain?: ChainRound;
  injectAddress?: string;
}): GameSession {
  const port = opts.injectChain ? null : createDevKeypairPort();
  let chain: ChainRound | null = opts.injectChain ?? null;
  let isDelegated = false;
  let armed = false;
  let bal = 0n;

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

    async ensureSession(buyInBase) {
      const c = need();
      if (isDelegated) return;
      const onL1 = await c.readPlayerBalance(false);
      if (onL1 === 0n) { await c.wrapForBuyIn(buyInBase); await c.buyIn(buyInBase); }
      await c.ensureRoundInited();
      await c.delegate(); // hardened: reuses a stale-but-live same-wallet session, else throws DelegateBusyError
      isDelegated = true;
      bal = await c.readPlayerBalance(true);
    },

    async open(asset, dir, lev, stakeBase) {
      const c = need();
      const opened = await c.open(asset, dir, lev, stakeBase);
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
      await need().commitAndUndelegate();
      isDelegated = false;
      bal = await need().readPlayerBalance(false);
    },

    async withdraw() {
      const c = need();
      const b = await c.readPlayerBalance(false);
      await c.withdraw(Number(b));
      await c.unwrapAll(); // wSOL → native SOL back in the wallet
      bal = await c.readPlayerBalance(false);
    },
  };
}
