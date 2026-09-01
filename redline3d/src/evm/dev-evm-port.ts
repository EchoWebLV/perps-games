import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAIN, EVM_USDC } from "./chain";
import type { EvmWalletPort } from "./wallet-port";

/**
 * Dev-only secret. VITE_DEV_EVM_SECRET (0x-prefixed 32-byte hex) lets `npm run dev` load a KNOWN
 * pre-funded wallet so the login → cashier flow works with no per-browser funding step. Written
 * as the exact `import.meta.env.VITE_*` form vite static-replaces at transform; absent in tests /
 * non-vite contexts, where the try/catch falls through. See chain.ts for why the form matters.
 */
function devSecretFromEnv(): `0x${string}` | undefined {
  let raw: string | undefined;
  try {
    raw = (import.meta.env.VITE_DEV_EVM_SECRET as string | undefined) || undefined;
  } catch {
    /* non-vite */
  }
  if (!raw) return undefined;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

/**
 * An {@link EvmWalletPort} backed by a local private key — dev only. Auto-signs (no popup) so the
 * on-chain loop is testable headlessly and in Claude Preview without Privy or a browser extension.
 * Mirrors chain/dev-keypair-port.ts: the key may be passed in, else it comes from the env var.
 *
 * Unlike the Solana twin this never GENERATES a key when none is configured — a fresh EVM key on a
 * mainnet L2 holds no funds and there is no airdrop, so a missing secret is a loud failure instead
 * of a silently useless wallet.
 */
export function createDevEvmPort(privateKey?: `0x${string}`): EvmWalletPort {
  const key = privateKey ?? devSecretFromEnv();
  if (!key) throw new Error("dev_evm_secret_missing");

  const account = privateKeyToAccount(key);
  // Lowercased everywhere so address comparisons upstream never hinge on EIP-55 checksum casing.
  const address = account.address.toLowerCase();
  const usdc = EVM_USDC as `0x${string}`;

  const wallet = createWalletClient({ account, chain: EVM_CHAIN, transport: http() });
  const publicClient = createPublicClient({ chain: EVM_CHAIN, transport: http() });

  return {
    kind: "dev-evm",
    async connect() {
      return { address };
    },
    // the key is local — restoring is always silent and always succeeds
    async reconnect() {
      return { address };
    },
    async disconnect() {
      /* no-op */
    },
    currentAddress() {
      return address;
    },
    async signMessage(message: string) {
      return account.signMessage({ message });
    },
    async sendUsdcTransfer(to: string, amountBaseUnits: bigint) {
      if (!EVM_USDC) throw new Error("evm_usdc_address_unset");
      return wallet.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to as `0x${string}`, amountBaseUnits],
      });
    },
    async usdcBalance() {
      if (!EVM_USDC) return null;
      try {
        return await publicClient.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        });
      } catch {
        return null; // RPC down / contract missing — the cashier shows "—" rather than crashing
      }
    },
  };
}
