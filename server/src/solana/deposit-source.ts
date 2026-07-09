import { createSolanaRpc, address, signature } from "@solana/kit";
import { fetchMint } from "@solana-program/token";
import type { InboundTransfer } from "../services/deposits.js";
import type { MintInfo } from "./mint-assert.js";

/**
 * One page of a treasury ATA's signature history (newest-first). `transfers` are the inbound USDC
 * transfers found in the page; `newestSig`/`oldestSig` are the RAW signature bounds of the page
 * (including dust/non-deposit sigs) so the caller can advance its cursor and paginate; `full` is
 * true when the page hit `limit` (older pages may exist).
 */
export interface InboundPage {
  transfers: InboundTransfer[];
  newestSig: string | null;
  oldestSig: string | null;
  full: boolean;
}

/** Reads finalized inbound USDC transfers to a treasury ATA, newest-first, within (untilSig, beforeSig). */
export interface DepositSource {
  fetchInbound(opts: { treasuryAta: string; untilSig?: string; beforeSig?: string; limit?: number }): Promise<InboundPage>;
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

interface ParsedTokenIx {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: {
      source?: string;
      destination?: string;
      mint?: string;
      amount?: string;
      tokenAmount?: { amount?: string };
    };
  };
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

function accountKeysFromTransaction(tx: any): string[] {
  return ((tx.transaction?.message?.accountKeys ?? []) as any[]).map((k) =>
    typeof k === "string" ? k : k.pubkey,
  );
}

function parsedInstructionsFromTransaction(tx: any): ParsedTokenIx[] {
  const topLevel = (tx.transaction?.message?.instructions ?? []) as ParsedTokenIx[];
  const inner = ((tx.meta?.innerInstructions ?? []) as Array<{ instructions?: ParsedTokenIx[] }>)
    .flatMap((group) => group.instructions ?? []);
  return [...topLevel, ...inner];
}

function tokenInstructionAmount(info: NonNullable<NonNullable<ParsedTokenIx["parsed"]>["info"]> | undefined): bigint | null {
  const raw = info?.tokenAmount?.amount ?? info?.amount;
  if (raw == null) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function findTreasuryTransferInstruction(
  tx: any,
  treasuryAta: string,
  mint: string,
  tokenProgram: string | undefined,
  amountBaseUnits: bigint,
): { source: string; programId: string } | null {
  for (const ix of parsedInstructionsFromTransaction(tx)) {
    const type = ix.parsed?.type;
    const info = ix.parsed?.info;
    if (ix.program && ix.program !== "spl-token") continue;
    if (type !== "transfer" && type !== "transferChecked") continue;
    if (!info?.source || info.destination !== treasuryAta) continue;
    if (info.mint && info.mint !== mint) continue;

    const amount = tokenInstructionAmount(info);
    if (amount !== amountBaseUnits) continue;
    if (tokenProgram && ix.programId && ix.programId !== tokenProgram) continue;

    return { source: info.source, programId: ix.programId ?? tokenProgram ?? "" };
  }

  return null;
}

export function inboundFromTransaction(txSig: string, slot: number, tx: any, treasuryAta: string): InboundTransfer | null {
  if (tx.meta?.err) return null;
  const pre = (tx.meta?.preTokenBalances ?? []) as TokenBal[];
  const post = (tx.meta?.postTokenBalances ?? []) as TokenBal[];
  const keys = accountKeysFromTransaction(tx);
  const ataIndex = keys.indexOf(treasuryAta);
  if (ataIndex < 0) return null;
  const preBal = pre.find((b) => b.accountIndex === ataIndex);
  const postBal = post.find((b) => b.accountIndex === ataIndex);
  if (!postBal) return null;
  const delta = BigInt(postBal.uiTokenAmount.amount) - BigInt(preBal?.uiTokenAmount.amount ?? "0");
  if (delta <= 0n) return null;

  const treasuryTransfer = findTreasuryTransferInstruction(tx, treasuryAta, postBal.mint, postBal.programId, delta);
  if (!treasuryTransfer) return null;

  const sourceIndex = keys.indexOf(treasuryTransfer.source);
  if (sourceIndex < 0) return null;
  const sourcePre = pre.find((b) => b.accountIndex === sourceIndex);
  const sourcePost = post.find((b) => b.accountIndex === sourceIndex);
  if (!sourcePre || !sourcePost) return null;
  if (sourcePre.mint !== postBal.mint || sourcePost.mint !== postBal.mint) return null;

  const tokenProgram = treasuryTransfer.programId || postBal.programId || sourcePre.programId || "";
  if (postBal.programId && tokenProgram !== postBal.programId) return null;
  if (sourcePre.programId && tokenProgram !== sourcePre.programId) return null;

  const sourceDelta = BigInt(sourcePre.uiTokenAmount.amount) - BigInt(sourcePost.uiTokenAmount.amount);
  if (sourceDelta < delta) return null;

  return {
    txSig,
    slot,
    finalized: true,
    mint: postBal.mint,
    tokenProgram,
    destAta: treasuryAta,
    sourceOwner: sourcePre.owner ?? "",
    amountBaseUnits: delta,
  };
}

export function makeRpcDepositSource(rpcUrl: string): DepositSource {
  const rpc = createSolanaRpc(rpcUrl);

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
    async fetchInbound({ treasuryAta, untilSig, beforeSig, limit = 100 }) {
      const sigs = await withRpcTimeout(rpc
        .getSignaturesForAddress(address(treasuryAta), {
          ...(untilSig ? { until: signature(untilSig) } : {}),
          ...(beforeSig ? { before: signature(beforeSig) } : {}),
          limit,
          commitment: "finalized",
        })
        .send());
      const transfers: InboundTransfer[] = [];
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
        if (inbound) transfers.push(inbound);
      }
      // page bounds are the RAW signature edges (incl. dust) so the caller can advance past dust and
      // fetch the next older page with `before: oldestSig`. `full` => the page hit `limit` (more exist).
      return {
        transfers,
        newestSig: sigs.length ? sigs[0].signature : null,
        oldestSig: sigs.length ? sigs[sigs.length - 1].signature : null,
        full: sigs.length === limit,
      };
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
