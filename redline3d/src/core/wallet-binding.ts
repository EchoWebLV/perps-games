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
