/**
 * Server-authored USDC `transferChecked` transaction builder (real-money rails, spec §5/§6).
 *
 * The server is the SOLE author of the transaction message (§5): it builds the full tx from
 * server-trusted inputs, controls 100% of the message bytes (Phase 0 confirmed Privy signs the
 * exact caller-supplied bytes — no blockhash/instruction param), and reserves the signature
 * slots that Privy fills later. Used for BOTH directions:
 *   - deposit: source = user ATA, authority = user wallet, dest = treasury ATA, feePayer = treasury
 *   - withdraw: source = treasury ATA, authority = treasury, dest = user ATA, feePayer = treasury
 *
 * The `authority` is reserved via {@link createNoopSigner} so the compiled tx marks it as a
 * SIGNER slot (a bare `Address` would compile to a NON-signer and the SPL program would reject
 * the transfer). The fee-payer becomes a signer automatically at compile time. Amounts are USDC
 * base units (see `money/usdc.ts`); `decimals` must match the on-chain mint (boot-asserted = 6).
 *
 * Built on `@solana/kit` v5 (web3.js v2) — the same stack `@privy-io/node` uses, pinned to one
 * copy so the branded `Address`/`Transaction` types unify at the Privy signing boundary.
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
  /** Owner/authority of the source ATA — reserved as a signer slot, signed later by Privy. */
  authority: Address;
  /** Pays the network fee — reserved as a signer slot, signed later by Privy. */
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
    // noop-signer reserves the authority's signer slot without a key (Privy signs it).
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
 * Compile + base64-encode the UNSIGNED transaction for Privy's `transaction` param (§5/§6).
 * Deterministic for given args. Privy fills the reserved feePayer + authority signature slots;
 * staging item 5 validates byte-for-byte fidelity of what Privy signs.
 */
export function buildUnsignedTransferCheckedWireTx(args: TransferCheckedTxArgs): string {
  return getBase64EncodedWireTransaction(compileTransaction(buildTransferCheckedMessage(args)));
}

/** Re-export for call sites that validate/normalize untrusted address strings. */
export const address = _address;
