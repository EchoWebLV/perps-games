import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
  type TransactionSignature,
} from "@solana/web3.js";
import type { AnchorWalletLike } from "./anchor-wallet";
import { CHAIN } from "./config";

export interface SolPaymentIo {
  latestBlockhash(): Promise<BlockhashWithExpiryBlockHeight>;
  sign(tx: Transaction): Promise<Transaction>;
  sendRaw(raw: Uint8Array): Promise<TransactionSignature>;
  confirm(strategy: BlockhashWithExpiryBlockHeight & { signature: TransactionSignature }): Promise<{ err: unknown }>;
}

export const solToLamports = (sol: number): number => {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error("invalid_sol_payment_amount");
  return lamports;
};

export function buildSolTransfer(
  from: PublicKey,
  to: PublicKey,
  lamports: number,
  recentBlockhash: string,
): Transaction {
  return new Transaction({ feePayer: from, recentBlockhash }).add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }),
  );
}

export async function payNativeSol(args: {
  from: PublicKey;
  to: PublicKey;
  sol: number;
  io: SolPaymentIo;
}): Promise<TransactionSignature> {
  const latest = await args.io.latestBlockhash();
  const tx = buildSolTransfer(args.from, args.to, solToLamports(args.sol), latest.blockhash);
  const signed = await args.io.sign(tx);
  const signature = await args.io.sendRaw(
    signed.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
  const confirmation = await args.io.confirm({ signature, ...latest });
  if (confirmation.err) throw new Error("sol_payment_unconfirmed");
  return signature;
}

export function makeSolPaymentIo(wallet: AnchorWalletLike, rpc = CHAIN.BASE_RPC): SolPaymentIo {
  const connection = new Connection(rpc, "confirmed");
  return {
    latestBlockhash: () => connection.getLatestBlockhash("confirmed"),
    sign: (tx) => wallet.signTransaction(tx),
    sendRaw: (raw) => connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" }),
    confirm: async (strategy) => (await connection.confirmTransaction(strategy, "confirmed")).value,
  };
}

export async function payDevnetSol(
  wallet: AnchorWalletLike,
  treasuryAddress: string,
  sol: number,
): Promise<TransactionSignature> {
  if (!treasuryAddress.trim()) throw new Error("crate_treasury_not_configured");
  return payNativeSol({
    from: wallet.publicKey,
    to: new PublicKey(treasuryAddress),
    sol,
    io: makeSolPaymentIo(wallet),
  });
}
