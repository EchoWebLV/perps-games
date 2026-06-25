/**
 * Self-custody treasury withdraw signer (real-money rails, spec §6 / money-rails-3).
 *
 * Implements the {@link WithdrawSigner} port: builds a treasury→user `transferChecked`,
 * signs it with the LOCAL treasury keypair, and broadcasts it. The treasury owner is BOTH
 * the source-ATA authority and the fee payer, so one keypair fills both signer slots.
 *
 * There is no provider-side idempotency key (a local keypair has none). Exactly-once is the
 * caller's DB state machine: `approveAndSend` claims `awaiting_approval → signing` as a
 * single-row conditional update, and a `sent` row is never re-sent. `idempotencyKey` is
 * accepted to satisfy the port but is not used for dedup here.
 *
 * Split (mirrors fee-payer-signer.ts): a keypair-injected core for unit tests + an
 * RPC-backed constructor for production.
 */
import {
  address,
  type Base64EncodedWireTransaction,
  type BlockhashLifetimeConstraint,
  assertIsFullySignedTransaction,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { buildTransferCheckedMessage } from "./transfer-tx.js";
import { parseFeePayerSecret } from "./fee-payer-signer.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";
import { USDC_DECIMALS, centsToBaseUnits } from "../money/usdc.js";
import type { WithdrawSigner } from "../services/withdraw-worker.js";

export interface TreasurySignerDeps {
  /** Treasury token authority = fee payer (the keypair's own address). */
  treasuryOwner: string;
  /** Treasury USDC ATA (the transfer source). */
  treasuryUsdcAta: string;
  /** USDC mint. */
  usdcMint: string;
  /** Fresh recent-blockhash lifetime (reuse `makeRpcBlockhash`). */
  getLatestBlockhash: () => Promise<BlockhashLifetimeConstraint>;
  /** Broadcast a base64 wire tx, returning the signature. */
  sendTransaction: (wireBase64: string) => Promise<string>;
}

export function makeTreasuryWithdrawSignerFromKeyPair(
  keyPair: CryptoKeyPair,
  deps: TreasurySignerDeps,
): WithdrawSigner {
  const mint = address(deps.usdcMint);
  const tokenProgram = address(LEGACY_TOKEN_PROGRAM);
  const source = address(deps.treasuryUsdcAta);
  const authority = address(deps.treasuryOwner);

  return {
    async signAndSend({ destWallet, amountCents }) {
      const [destination] = await findAssociatedTokenPda({
        owner: address(destWallet),
        mint,
        tokenProgram,
      });
      const lifetime = await deps.getLatestBlockhash();
      const message = buildTransferCheckedMessage({
        source,
        mint,
        destination,
        authority, // reserved as a signer slot by the builder
        feePayer: authority, // treasury pays its own SOL fee
        amount: centsToBaseUnits(BigInt(amountCents)),
        decimals: USDC_DECIMALS,
        lifetime,
      });
      const signed = await partiallySignTransaction([keyPair], compileTransaction(message));
      assertIsFullySignedTransaction(signed);
      const txSig = await deps.sendTransaction(getBase64EncodedWireTransaction(signed));
      return { txSig, providerTxId: null };
    },
  };
}

/**
 * RPC-backed treasury signer from a secret (JSON byte array or base64, like FEE_PAYER_SECRET).
 * Exposes `.address` so boot can assert it equals the configured TREASURY_OWNER_PUBKEY.
 */
export async function makeTreasuryWithdrawSigner(
  secret: string,
  cfg: { rpcUrl: string; treasuryUsdcAta: string; usdcMint: string; getLatestBlockhash: () => Promise<BlockhashLifetimeConstraint> },
): Promise<WithdrawSigner & { address: string }> {
  const signer = await createKeyPairSignerFromBytes(parseFeePayerSecret(secret), false);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const core = makeTreasuryWithdrawSignerFromKeyPair(signer.keyPair, {
    treasuryOwner: signer.address,
    treasuryUsdcAta: cfg.treasuryUsdcAta,
    usdcMint: cfg.usdcMint,
    getLatestBlockhash: cfg.getLatestBlockhash,
    sendTransaction: (wireBase64) =>
      rpc.sendTransaction(wireBase64 as Base64EncodedWireTransaction, { encoding: "base64" }).send(),
  });
  return { address: signer.address, signAndSend: core.signAndSend };
}
