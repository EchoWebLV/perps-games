import type { Api } from "./api";
import type { SolanaWalletPort } from "./solana-wallet";
import type { EvmWalletPort } from "../evm/wallet-port";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (const byte of bytes) {
    if (byte === 0) out += "1";
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/**
 * First line of every binding challenge the server issues — see `messageFor()` in
 * server/src/auth/wallet-binding.ts. Kept here as a literal on purpose: it is the client's ONLY
 * evidence that the text it is about to sign is a binding challenge and not something else.
 */
const BIND_MESSAGE_PREFIX = "Perps Rider wallet binding";

/**
 * Refuse to sign server text that is not a binding challenge for THIS wallet.
 *
 * Signing is silent on the EVM rail (`showWalletUIs:false`), so the player never sees what the
 * wallet is being asked to sign. Without this check a MITM'd or hostile API could return any
 * message — a SIWE "sign in with Ethereum" payload for another site, say — and get it signed with
 * no prompt at all. That is login theft rather than fund theft, but the challenge shape is known
 * and cheap to assert, so assert it.
 *
 * `fold` case-folds the comparison for EVM, where the address is hex and the server stores it
 * lowercased while wallets hand back the EIP-55 form. Solana's base58 is case-SIGNIFICANT and is
 * compared verbatim.
 */
function assertBindChallenge(message: string, address: string, fold: boolean): void {
  const haystack = fold ? message.toLowerCase() : message;
  const needle = fold ? address.toLowerCase() : address;
  if (!message.startsWith(BIND_MESSAGE_PREFIX) || !haystack.includes(needle)) {
    throw new Error("bind_challenge_malformed");
  }
}

/**
 * The EVM rail's bind: connect → server nonce challenge → EIP-191 personal_sign → bind.
 *
 * Sits NEXT TO the Solana flavour rather than replacing it — the Solana rail is parked, not gone.
 * Two contract details drive the shape:
 *  - the server verifies EIP-191 over the challenge's `message` and stores/returns the wallet
 *    LOWERCASED, so the echo check compares case-insensitively and the bound address is used as-is;
 *  - a challenge is single-use. Every call fetches its own nonce and signs THAT message, so a
 *    retry after a failed bind can never replay a spent challenge.
 */
export async function connectAndBindEvmWallet(input: {
  port: Pick<EvmWalletPort, "connect" | "signMessage">;
  api: Pick<Api, "bindWalletChallenge" | "bindWallet">;
}) {
  const connected = await input.port.connect();
  const challenge = await input.api.bindWalletChallenge(connected.address);
  if (challenge.wallet.toLowerCase() !== connected.address.toLowerCase()) throw new Error("wallet_mismatch");
  assertBindChallenge(challenge.message, connected.address, true);
  const signature = await input.port.signMessage(challenge.message);
  const bound = await input.api.bindWallet({ challenge: challenge.challenge, signature });
  return {
    address: bound.wallet,
    session: bound.token && bound.userId ? { token: bound.token, userId: bound.userId } : undefined,
  };
}

export async function connectAndBindWallet(input: {
  port: SolanaWalletPort;
  api: Pick<Api, "bindWalletChallenge" | "bindWallet">;
}) {
  const connected = await input.port.connect();
  const challenge = await input.api.bindWalletChallenge(connected.address);
  if (challenge.wallet !== connected.address) throw new Error("wallet_mismatch");
  assertBindChallenge(challenge.message, connected.address, false);
  const signature = await input.port.signMessage(new TextEncoder().encode(challenge.message));
  const bound = await input.api.bindWallet({
    challenge: challenge.challenge,
    signatureBase58: base58Encode(signature),
  });
  return {
    address: bound.wallet,
    label: connected.label,
    session: bound.token && bound.userId ? { token: bound.token, userId: bound.userId } : undefined,
  };
}
