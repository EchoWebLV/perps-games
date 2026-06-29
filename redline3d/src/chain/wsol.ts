import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/** Native SOL's SPL mint. Wrapping = transfer lamports into a wSOL token account + syncNative. */
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** The owner's associated wSOL token account. */
export function wsolAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(WSOL_MINT, owner);
}

/**
 * Instructions to wrap `lamports` of native SOL into the owner's wSOL ATA.
 * Pass `ataExists` from a prior getAccountInfo to skip redundant ATA creation.
 */
export function buildWrapIxs(args: { owner: PublicKey; lamports: bigint; ataExists: boolean }): TransactionInstruction[] {
  const ata = wsolAta(args.owner);
  const ixs: TransactionInstruction[] = [];
  if (!args.ataExists) {
    ixs.push(createAssociatedTokenAccountInstruction(args.owner, ata, args.owner, WSOL_MINT));
  }
  ixs.push(SystemProgram.transfer({ fromPubkey: args.owner, toPubkey: ata, lamports: args.lamports }));
  ixs.push(createSyncNativeInstruction(ata));
  return ixs;
}

/** Instruction to unwrap: close the wSOL ATA, returning all lamports (incl. rent) to the owner. */
export function buildUnwrapIxs(args: { owner: PublicKey }): TransactionInstruction[] {
  const ata = wsolAta(args.owner);
  return [createCloseAccountInstruction(ata, args.owner, args.owner, [], TOKEN_PROGRAM_ID)];
}
