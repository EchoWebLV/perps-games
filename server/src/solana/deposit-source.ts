import { createSolanaRpc, address, signature } from "@solana/kit";
import { fetchMint } from "@solana-program/token";
import type { InboundTransfer } from "../services/deposits.js";
import type { MintInfo } from "./mint-assert.js";

/** Reads finalized inbound USDC transfers to a treasury ATA, newest-first, stopping at `untilSig`. */
export interface DepositSource {
  fetchInbound(opts: { treasuryAta: string; untilSig?: string; limit?: number }): Promise<InboundTransfer[]>;
  fetchTransfer?(opts: { treasuryAta: string; txSig: string }): Promise<InboundTransfer | null>;
  fetchMintInfo(mint: string): Promise<MintInfo>;
  /** Treasury USDC ATA balance in base units (for the withdraw solvency precheck). */
  readTreasuryBaseUnits(ata: string): Promise<bigint>;
}

/** Token-balance entry as returned by getTransaction(jsonParsed).meta.{pre,post}TokenBalances. */
interface TokenBal {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string };
}

async function withRpcTimeout<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("solana_rpc_timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function makeRpcDepositSource(rpcUrl: string): DepositSource {
  const rpc = createSolanaRpc(rpcUrl);

  function inboundFromTransaction(txSig: string, slot: number, tx: any, treasuryAta: string): InboundTransfer | null {
    const pre = (tx.meta?.preTokenBalances ?? []) as TokenBal[];
    const post = (tx.meta?.postTokenBalances ?? []) as TokenBal[];
    // jsonParsed accountKeys are ParsedAccount objects ({ pubkey }); tolerate raw strings too.
    const keys: string[] = (tx.transaction.message.accountKeys as any[]).map((k) =>
      typeof k === "string" ? k : k.pubkey,
    );
    const ataIndex = keys.indexOf(treasuryAta);
    if (ataIndex < 0) return null;
    const preBal = pre.find((b) => b.accountIndex === ataIndex);
    const postBal = post.find((b) => b.accountIndex === ataIndex);
    if (!postBal) return null;
    const delta = BigInt(postBal.uiTokenAmount.amount) - BigInt(preBal?.uiTokenAmount.amount ?? "0");
    if (delta <= 0n) return null;
    const source = pre.find((b) => {
      const matchPost = post.find((p) => p.accountIndex === b.accountIndex);
      return (
        b.accountIndex !== ataIndex &&
        matchPost !== undefined &&
        BigInt(matchPost.uiTokenAmount.amount) < BigInt(b.uiTokenAmount.amount)
      );
    });
    return {
      txSig,
      slot,
      finalized: true,
      mint: postBal.mint,
      tokenProgram: postBal.programId ?? "",
      destAta: treasuryAta,
      sourceOwner: source?.owner ?? "",
      amountBaseUnits: delta,
    };
  }

  return {
    async fetchMintInfo(mint) {
      // BaseAccount carries `programAddress`; the decoded Mint carries `data.decimals`.
      const m = await fetchMint(rpc, address(mint));
      return { decimals: m.data.decimals, programAddress: m.programAddress as string };
    },
    async readTreasuryBaseUnits(ata) {
      const res = await rpc.getTokenAccountBalance(address(ata), { commitment: "finalized" } as any).send();
      return BigInt((res as any).value.amount);
    },
    async fetchInbound({ treasuryAta, untilSig, limit = 100 }) {
      const sigs = await withRpcTimeout(rpc
        .getSignaturesForAddress(address(treasuryAta), {
          ...(untilSig ? { until: signature(untilSig) } : {}),
          limit,
          commitment: "finalized",
        })
        .send());
      const out: InboundTransfer[] = [];
      for (const s of sigs) {
        if (s.err) continue; // landed-but-failed: no tokens moved
        let tx: any;
        try {
          tx = await withRpcTimeout(rpc
            .getTransaction(signature(s.signature), {
              maxSupportedTransactionVersion: 0,
              commitment: "finalized",
              encoding: "jsonParsed",
            })
            .send());
        } catch (e) {
          if (e instanceof Error && e.message === "solana_rpc_timeout") continue;
          throw e;
        }
        if (!tx) continue;
        const inbound = inboundFromTransaction(s.signature, Number(s.slot), tx, treasuryAta);
        if (inbound) out.push(inbound);
      }
      return out;
    },
    async fetchTransfer({ treasuryAta, txSig }) {
      let tx: any;
      try {
        tx = await withRpcTimeout(rpc
          .getTransaction(signature(txSig), {
            maxSupportedTransactionVersion: 0,
            commitment: "finalized",
            encoding: "jsonParsed",
          })
          .send());
      } catch (e) {
        if (e instanceof Error && e.message === "solana_rpc_timeout") return null;
        throw e;
      }
      if (!tx || tx.meta?.err) return null;
      return inboundFromTransaction(txSig, Number(tx.slot), tx, treasuryAta);
    },
  };
}
