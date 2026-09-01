import { erc20Abi } from "viem";
import type { Env } from "../env.js";
import { baseUnitsToCentsFloor, USDC_DECIMALS } from "../money/usdc.js";
import { makeDeposits } from "../services/deposits.js";
import type { DepositCursorStore } from "../services/deposit-worker.js";
import type { Ledger } from "../services/ledger.js";
import type { ReadChainStatus, WithdrawSigner } from "../services/withdraw-worker.js";
import { makeEvmChainStatusReader } from "./chain-status.js";
import { makePublicClient, makeTreasuryWalletClient } from "./client.js";
import { makeEvmDepositConfirmer } from "./deposit-confirmer.js";
import { EVM_TOKEN_LABEL, makeEvmDepositSource } from "./deposit-source.js";
import { makeEvmTreasurySigner } from "./treasury-signer.js";

/**
 * Everything the EVM money rail needs, built once at boot. Deliberately mirrors the locals the
 * Solana branch of index.ts assigns, so `buildServer` receives the same shapes either way and the
 * HTTP layer stays rail-agnostic.
 */
export interface EvmRail {
  /** Lowercased EVM_TREASURY_ADDRESS — the deposit destination served to clients. */
  treasury: string;
  deposits: ReturnType<typeof makeDeposits>;
  /** Deposit confirmer, given the durable cursor store (the caller owns the db handle). */
  makeConfirmer(store: DepositCursorStore): ReturnType<typeof makeEvmDepositConfirmer>;
  /** Self-custody send leg. Null unless EVM_TREASURY_SECRET is configured (withdraw-approval 404s). */
  treasurySigner: WithdrawSigner | null;
  chainStatus: ReadChainStatus;
  /** Treasury USDC balance in base units — the withdraw solvency precheck. */
  readTreasuryBaseUnits(): Promise<bigint>;
  /** A user wallet's USDC balance in cents (display read; sub-cent dust floored). */
  walletUsdcCents(wallet: string): Promise<number>;
}

/**
 * Build the EVM rail, refusing to boot on any misconfiguration.
 *
 * Every failure here is a THROW, not a warning: a rail that boots against the wrong token or a
 * treasury nobody holds the key to would take real user money and strand it. The env vars are
 * re-checked even though env.ts requires them under REAL_MONEY_ENABLED — this function must be safe
 * to call from anywhere, and a null-assertion here would surface as an opaque RPC error later.
 */
export async function bootEvmRail(env: Env, deps: { db: any; ledger: Ledger }): Promise<EvmRail> {
  for (const k of ["EVM_RPC_URL", "EVM_CHAIN_ID", "EVM_USDC_ADDRESS", "EVM_TREASURY_ADDRESS"] as const) {
    if (!env[k]) throw new Error(`refusing to boot the EVM rail: ${k} is not set`);
  }
  const rpcUrl = env.EVM_RPC_URL!;
  const chainId = env.EVM_CHAIN_ID!;
  // env.ts already lowercases both; re-lowercasing is a cheap guarantee for any other caller.
  const usdc = env.EVM_USDC_ADDRESS!.toLowerCase();
  const treasury = env.EVM_TREASURY_ADDRESS!.toLowerCase();

  const pub = makePublicClient({ chainId, rpcUrl, rpcUrlFallback: env.EVM_RPC_URL_FALLBACK });
  const source = makeEvmDepositSource(pub, {
    usdc,
    treasury,
    confirmations: env.EVM_CONFIRMATIONS,
    maxBlockRange: BigInt(env.EVM_MAX_BLOCK_RANGE),
  });

  // The whole money path converts base units ⇄ cents at a fixed 10^6 scale. A token with any other
  // decimals would silently credit 10^n times the real amount, so this is checked before anything
  // else touches it (spec §5, the EVM twin of solana/mint-assert).
  const decimals = await source.tokenDecimals();
  if (decimals !== USDC_DECIMALS) {
    throw new Error(
      `refusing to boot the EVM rail: EVM_USDC_ADDRESS ${usdc} reports ${decimals} decimals, expected ${USDC_DECIMALS}`,
    );
  }

  // Where a fresh deploy (no persisted cursor) starts scanning, so the first tick is not a walk from
  // genesis. Read once, at boot: later ticks resume from the durable cursor instead.
  //
  // Backs off by the confirmation depth rather than starting at the head: the source only scans up to
  // `head - confirmations`, so a transfer broadcast just before boot — mined, but not yet that deep —
  // sits BELOW the head and would never be scanned if we started there. That whole tail is re-covered
  // here; `recordInbound` is idempotent on txSig, so rescanning already-seen blocks cannot double-credit.
  const head = await pub.getBlockNumber();
  const confirmationDepth = BigInt(env.EVM_CONFIRMATIONS);
  const startBlock = head > confirmationDepth ? head - confirmationDepth : 0n;

  const deposits = makeDeposits(deps.db, deps.ledger, {
    usdcMint: usdc,
    treasuryAta: treasury,
    minCents: env.DEPOSIT_MIN_CENTS,
    maxCents: env.DEPOSIT_MAX_CENTS,
    expectedTokenProgram: EVM_TOKEN_LABEL,
  });

  let treasurySigner: WithdrawSigner | null = null;
  if (env.EVM_TREASURY_SECRET) {
    const wallet = makeTreasuryWalletClient({ chainId, rpcUrl, secret: env.EVM_TREASURY_SECRET as `0x${string}` });
    // The signer spends the treasury. If the secret is not the treasury's, every withdrawal would be
    // sent from — and drain — some other account, so a mismatch must stop the boot.
    if (wallet.address.toLowerCase() !== treasury) {
      throw new Error("refusing to boot the EVM rail: EVM_TREASURY_ADDRESS does not match EVM_TREASURY_SECRET");
    }
    treasurySigner = makeEvmTreasurySigner(wallet.client, { usdc });
  }

  return {
    treasury,
    deposits,
    makeConfirmer: (store) =>
      makeEvmDepositConfirmer({ deposits, source, store, treasury, pollMs: env.DEPOSIT_POLL_MS, startBlock }),
    treasurySigner,
    chainStatus: makeEvmChainStatusReader(pub, env.EVM_CONFIRMATIONS),
    readTreasuryBaseUnits: () => source.readTreasuryBaseUnits(),
    async walletUsdcCents(wallet) {
      const balance = (await pub.readContract({
        address: usdc as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.toLowerCase() as `0x${string}`],
      })) as bigint;
      // Display read: a wallet may hold sub-cent dust, so floor rather than throw (see usdc.ts).
      return Number(baseUnitsToCentsFloor(balance));
    },
  };
}
