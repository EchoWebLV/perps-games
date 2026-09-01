import { createPublicClient, createWalletClient, erc20Abi, http, zeroAddress } from "viem";
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
 * Seams for the two contract calls on the money path, so tests can assert exactly what gets
 * encoded without standing up an RPC. Both default to real viem clients on {@link EVM_CHAIN};
 * `usdcAddress` defaults to {@link EVM_USDC}.
 */
export interface DevEvmPortDeps {
  writeContract?: (args: {
    address: `0x${string}`;
    abi: typeof erc20Abi;
    functionName: "transfer";
    args: readonly [`0x${string}`, bigint];
  }) => Promise<`0x${string}`>;
  readContract?: (args: {
    address: `0x${string}`;
    abi: typeof erc20Abi;
    functionName: "balanceOf";
    args: readonly [`0x${string}`];
  }) => Promise<bigint>;
  usdcAddress?: string;
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
export function createDevEvmPort(privateKey?: `0x${string}`, deps: DevEvmPortDeps = {}): EvmWalletPort {
  const key = privateKey ?? devSecretFromEnv();
  if (!key) throw new Error("dev_evm_secret_missing");

  const account = privateKeyToAccount(key);
  // Everything address-shaped is lowercased on the way in. viem 2.x validates EIP-55: a
  // mixed-case address whose checksum does not match throws InvalidAddressError at ENCODE
  // time, so an all-caps or non-checksummed treasury address from the server would fail
  // every transfer. All-lowercase is always accepted, and it keeps comparisons upstream off
  // checksum casing too.
  const address = account.address.toLowerCase() as `0x${string}`;
  const usdc = (deps.usdcAddress ?? EVM_USDC).toLowerCase() as `0x${string}`;

  const makeWallet = () => createWalletClient({ account, chain: EVM_CHAIN, transport: http() });
  const makePublic = () => createPublicClient({ chain: EVM_CHAIN, transport: http() });
  let wallet: ReturnType<typeof makeWallet> | null = null;
  let publicClient: ReturnType<typeof makePublic> | null = null;

  const writeContract: NonNullable<DevEvmPortDeps["writeContract"]> =
    deps.writeContract ?? ((args) => (wallet ??= makeWallet()).writeContract(args));
  const readContract: NonNullable<DevEvmPortDeps["readContract"]> =
    deps.readContract ?? ((args) => (publicClient ??= makePublic()).readContract(args));

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
      // Validate the caller's argument before the build's config: a bad recipient is the
      // more actionable error, and viem would happily encode a transfer to 0x0 as a burn.
      const recipient = to.toLowerCase() as `0x${string}`;
      if (recipient === zeroAddress) throw new Error("evm_transfer_to_zero");
      if (!usdc) throw new Error("evm_usdc_address_unset");
      return writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient, amountBaseUnits],
      });
    },
    async usdcBalance() {
      if (!usdc) return null;
      try {
        return await readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
      } catch {
        return null; // RPC down / contract missing — the cashier shows "—" rather than crashing
      }
    },
  };
}
