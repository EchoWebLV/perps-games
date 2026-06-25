/**
 * Server-authored USDC `transferChecked` transaction builder (real-money rails, spec §5/§6).
 *
 * The server is the sole author of the transaction message (§5): it builds the full tx from
 * trusted inputs, controls the message bytes, and reserves any signer slots the caller must
 * satisfy later. Used for both directions:
 *   - deposit: source = user ATA, authority = user wallet, dest = treasury ATA, feePayer = optional server fee payer
 *   - withdraw: source = treasury ATA, authority = treasury authority, dest = user ATA, feePayer = optional server fee payer
 *
 * The `authority` is reserved via {@link createNoopSigner} so the compiled tx marks it as a
 * SIGNER slot (a bare `Address` would compile to a NON-signer and the SPL program would reject
 * the transfer). The fee payer becomes a signer automatically at compile time when one is
 * configured. The instruction uses the legacy SPL Token program. Amounts are USDC base units
 * (see `money/usdc.ts`); `decimals` must match the on-chain mint (boot-asserted = 6).
 *
 * Built on `@solana/kit` v5 (web3.js v2), pinned to one copy so the branded
 * `Address`/`Transaction` types unify at the signing boundary.
 */
import {
  address as _address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type BlockhashLifetimeConstraint,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";

export interface TransferCheckedTxArgs {
  /** Source token account (ATA). */
  source: Address;
  /** Token mint (USDC). */
  mint: Address;
  /** Destination token account (ATA). */
  destination: Address;
  /** Owner or authority of the source ATA, reserved as a signer slot for later signing. */
  authority: Address;
  /** Pays the network fee. When configured, this signer is supplied by the server. */
  feePayer: Address;
  /** Amount in USDC base units (use `centsToBaseUnits`). */
  amount: bigint;
  /** Mint decimals — MUST equal the boot-asserted on-chain value (6 for USDC). */
  decimals: number;
  /** Recent-blockhash lifetime (server-fetched). Durable nonce is a future caller variant. */
  lifetime: BlockhashLifetimeConstraint;
}

/** Build the unsigned `transferChecked` transaction MESSAGE (v0). Pure — no RPC. */
export function buildTransferCheckedMessage(args: TransferCheckedTxArgs) {
  const instruction = getTransferCheckedInstruction({
    source: args.source,
    mint: args.mint,
    destination: args.destination,
    // Reserve the authority signer slot without attaching a private key at build time.
    authority: createNoopSigner(args.authority),
    amount: args.amount,
    decimals: args.decimals,
  });
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(args.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(args.lifetime, m),
    (m) => appendTransactionMessageInstruction(instruction, m),
  );
}

/**
 * Compile and base64-encode the unsigned transaction payload for later signing (§5/§6).
 * Deterministic for given args. The source-account authority signs the reserved authority slot,
 * and an optional server fee payer signs its slot when configured.
 */
export function buildUnsignedTransferCheckedWireTx(args: TransferCheckedTxArgs): string {
  return getBase64EncodedWireTransaction(compileTransaction(buildTransferCheckedMessage(args)));
}

/** Re-export for call sites that validate/normalize untrusted address strings. */
export const address = _address;
