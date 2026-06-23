import { createSolanaRpc, address, signature } from "@solana/kit";
import { fetchMint } from "@solana-program/token";
import type { InboundTransfer } from "../services/deposits.js";
import type { MintInfo } from "./mint-assert.js";

/** Reads finalized inbound USDC transfers to a treasury ATA, newest-first, stopping at `untilSig`. */
export interface DepositSource {
  fetchInbound(opts: { treasuryAta: string; untilSig?: string; limit?: number }): Promise<InboundTransfer[]>;
  fetchMintInfo(mint: string): Promise<MintInfo>;
}

/** Token-balance entry as returned by getTransaction(jsonParsed).meta.{pre,post}TokenBalances. */
interface TokenBal {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string };
}

export function makeRpcDepositSource(rpcUrl: string): DepositSource {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async fetchMintInfo(mint) {
      // BaseAccount carries `programAddress`; the decoded Mint carries `data.decimals`.
      const m = await fetchMint(rpc, address(mint));
      return { decimals: m.data.decimals, programAddress: m.programAddress as string };
    },
    async fetchInbound({ treasuryAta, untilSig, limit = 100 }) {
      const sigs = await rpc
        .getSignaturesForAddress(address(treasuryAta), {
          ...(untilSig ? { until: signature(untilSig) } : {}),
          limit,
          commitment: "finalized",
        })
        .send();
      const out: InboundTransfer[] = [];
      for (const s of sigs) {
        if (s.err) continue; // landed-but-failed: no tokens moved
        const tx = (await rpc
          .getTransaction(signature(s.signature), {
            maxSupportedTransactionVersion: 0,
            commitment: "finalized",
            encoding: "jsonParsed",
          })
          .send()) as any;
        if (!tx) continue;
        const pre = (tx.meta?.preTokenBalances ?? []) as TokenBal[];
        const post = (tx.meta?.postTokenBalances ?? []) as TokenBal[];
        // jsonParsed accountKeys are ParsedAccount objects ({ pubkey }); tolerate raw strings too.
        const keys: string[] = (tx.transaction.message.accountKeys as any[]).map((k) =>
          typeof k === "string" ? k : k.pubkey,
        );
        const ataIndex = keys.indexOf(treasuryAta);
        if (ataIndex < 0) continue;
        const preBal = pre.find((b) => b.accountIndex === ataIndex);
        const postBal = post.find((b) => b.accountIndex === ataIndex);
        if (!postBal) continue;
        const delta = BigInt(postBal.uiTokenAmount.amount) - BigInt(preBal?.uiTokenAmount.amount ?? "0");
        if (delta <= 0n) continue;
        const source = pre.find((b) => {
          const matchPost = post.find((p) => p.accountIndex === b.accountIndex);
          return (
            b.accountIndex !== ataIndex &&
            matchPost !== undefined &&
            BigInt(matchPost.uiTokenAmount.amount) < BigInt(b.uiTokenAmount.amount)
          );
        });
        out.push({
          txSig: s.signature,
          slot: Number(s.slot),
          finalized: true,
          mint: postBal.mint,
          tokenProgram: postBal.programId ?? "",
          destAta: treasuryAta,
          sourceOwner: source?.owner ?? "",
          amountBaseUnits: delta,
        });
      }
      return out;
    },
  };
}
