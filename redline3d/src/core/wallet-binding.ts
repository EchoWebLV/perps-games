import type { Api } from "./api";
import type { SolanaWalletPort } from "./solana-wallet";

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
