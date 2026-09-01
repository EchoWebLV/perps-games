import { erc20Abi, parseAbiItem, type PublicClient } from "viem";
import type { InboundTransfer } from "../services/deposits.js";

/**
 * EVM inbound-deposit source: ERC-20 `Transfer(*, treasury, *)` logs on the configured token.
 *
 * Chain-agnostic mapping onto the existing {@link InboundTransfer} shape (Deposits does not care
 * which rail produced it): `slot` = block number, `tokenProgram` = {@link EVM_TOKEN_LABEL}, which is
 * what `DepositsConfig.expectedTokenProgram` must be set to on this rail.
 */
export const EVM_TOKEN_LABEL = "erc20";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** One scanned block range. `toBlock` is the last block actually covered (the cursor's new value). */
export interface EvmInboundPage {
  transfers: InboundTransfer[];
  toBlock: bigint;
}

export interface EvmDepositSource {
  /** Inbound transfers in [fromBlock, safeHead]. An empty page with `toBlock < fromBlock` = nothing safe to scan yet. */
  fetchInboundRange(opts: { fromBlock: bigint }): Promise<EvmInboundPage>;
  /** ERC-20 `decimals()` of the configured token (boot-asserted against USDC_DECIMALS). */
  tokenDecimals(): Promise<number>;
  /** Treasury token balance in base units (for the withdraw solvency precheck). */
  readTreasuryBaseUnits(): Promise<bigint>;
}

type TransferLog = {
  address: string;
  transactionHash: string;
  blockNumber: bigint;
  args: { from: string; to: string; value: bigint };
};

/**
 * Pure log → InboundTransfer mapping. Every address is lowercased so it compares equal to the
 * lowercased addresses env.ts stores and users are registered under.
 */
export function inboundFromLog(log: TransferLog, cfg: { usdc: string; treasury: string }): InboundTransfer {
  return {
    txSig: log.transactionHash,
    slot: Number(log.blockNumber), // EVM block heights are far below 2^53
    finalized: true, // the source only scans up to `latest - confirmations`
    mint: cfg.usdc.toLowerCase(),
    tokenProgram: EVM_TOKEN_LABEL,
    destAta: cfg.treasury.toLowerCase(),
    sourceOwner: log.args.from.toLowerCase(),
    amountBaseUnits: log.args.value,
  };
}

export function makeEvmDepositSource(
  client: PublicClient,
  cfg: { usdc: string; treasury: string; confirmations: number },
): EvmDepositSource {
  const usdc = cfg.usdc.toLowerCase() as `0x${string}`;
  const treasury = cfg.treasury.toLowerCase() as `0x${string}`;

  return {
    async fetchInboundRange({ fromBlock }) {
      const head = await client.getBlockNumber();
      const safeHead = head - BigInt(cfg.confirmations);
      // Nothing has aged past the confirmation depth yet: report a range that ENDS BEFORE fromBlock so
      // the caller holds its cursor instead of advancing over blocks it never scanned.
      if (safeHead < fromBlock) return { transfers: [], toBlock: fromBlock - 1n };

      const logs = await client.getLogs({
        address: usdc,
        event: TRANSFER,
        args: { to: treasury },
        fromBlock,
        toBlock: safeHead,
      });
      const transfers = (logs as unknown as Array<TransferLog & { removed?: boolean }>)
        .filter((l) => !l.removed) // a reorg-removed log never happened; never credit it
        .map((l) => inboundFromLog(l, { usdc, treasury }));
      return { transfers, toBlock: safeHead };
    },

    async tokenDecimals() {
      return Number(await client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }));
    },

    async readTreasuryBaseUnits() {
      return (await client.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [treasury],
      })) as bigint;
    },
  };
}
