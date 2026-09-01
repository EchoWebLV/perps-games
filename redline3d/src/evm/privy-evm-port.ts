import { createPublicClient, erc20Abi, http } from "viem";
import { EVM_CHAIN, EVM_USDC } from "./chain";
import type { EvmWalletPort } from "./wallet-port";

/** The minimal island surface the port needs (privy-evm-island.ts publishes this). */
export interface PrivyEvmIsland {
  /** Triggers Privy login, ensures an embedded EVM wallet, returns its address. */
  connect(): Promise<string>;
  /** EIP-191 personal_sign; resolves the 0x-hex signature. */
  signMessage(message: string): Promise<string>;
  /** ERC-20 USDC transfer from the embedded wallet; resolves the tx hash. */
  sendUsdcTransfer(to: string, amountBaseUnits: bigint): Promise<string>;
  currentAddress(): string | null;
  /** Silent restore of a persisted login; never opens the modal. */
  reconnect(): Promise<string | null>;
  /** Privy sign-out — clears the auth session so the next connect() shows the login modal. */
  logout(): Promise<void>;
}

/** Lowercased everywhere the port hands an address upward: the server stores and echoes bound
 *  wallets lowercased, so an EIP-55 checksum leaking out would break `===` comparisons upstream. */
const lower = (a: string) => a.toLowerCase();

/** Default balance read — a plain viem public client against {@link EVM_CHAIN}. Injectable so the
 *  port is testable without a network or a configured USDC address. */
function defaultBalanceReader(): ((address: string) => Promise<bigint>) | null {
  if (!EVM_USDC) return null;
  const client = createPublicClient({ chain: EVM_CHAIN, transport: http() });
  return (address: string) =>
    client.readContract({
      address: EVM_USDC as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    });
}

/**
 * An {@link EvmWalletPort} backed by a Privy embedded EVM wallet (via the React island).
 * Mirrors chain/privy-wallet-port.ts for the Solana rail: the island owns every Privy/React
 * detail, this file is the pure adapter the game code sees.
 */
export function createPrivyEvmPort(deps: {
  island: PrivyEvmIsland;
  readUsdcBalance?: (address: string) => Promise<bigint>;
}): EvmWalletPort {
  const { island } = deps;
  let readBalance: ((address: string) => Promise<bigint>) | null | undefined = deps.readUsdcBalance;
  let address = "";
  return {
    kind: "privy-evm",
    async connect() {
      address = lower(await island.connect());
      return { address };
    },
    async reconnect() {
      const a = await island.reconnect();
      if (!a) return null;
      address = lower(a);
      return { address };
    },
    async disconnect() {
      address = "";
      await island.logout();
    },
    currentAddress() {
      const live = island.currentAddress();
      return live ? lower(live) : address || null;
    },
    async signMessage(message: string) {
      return island.signMessage(message);
    },
    async sendUsdcTransfer(to: string, amountBaseUnits: bigint) {
      return island.sendUsdcTransfer(to, amountBaseUnits);
    },
    async usdcBalance() {
      const live = island.currentAddress() ?? (address || null);
      if (!live) return null; // nothing connected — the cashier shows "—" rather than guessing
      readBalance ??= defaultBalanceReader(); // built lazily: unset USDC stays null forever
      if (!readBalance) return null;
      try {
        return await readBalance(lower(live));
      } catch {
        return null; // RPC down / contract missing — display problem, not a crash
      }
    },
  };
}

/** Privy persists its auth under `privy:`-prefixed localStorage keys — presence is the cheap
 *  "might still be logged in" probe that decides whether mounting the island is worth it. */
function hasPrivySession(): boolean {
  try {
    return Object.keys(globalThis.localStorage ?? {}).some((k) => k.startsWith("privy:"));
  } catch {
    return false;
  }
}

/**
 * The EVM twin of chain/wallet-select.ts's `createLazyPrivyPort`: returns synchronously so boot
 * needs no async restructuring, and dynamic-imports the React island (react +
 * @privy-io/react-auth) only on the first real connect — keeping it out of the default bundle,
 * and out of the path entirely when the dev port is picked.
 */
export function createLazyPrivyEvmPort(
  deps: {
    load?: () => Promise<EvmWalletPort>;
    hasPersistedSession?: () => boolean;
  } = {},
): EvmWalletPort {
  let inner: EvmWalletPort | null = null;
  let loading: Promise<EvmWalletPort> | null = null;
  const load =
    deps.load ??
    (async () => {
      // Only the ISLAND import is dynamic — that is the one carrying react + @privy-io, and
      // keeping it out of the default chunk is the entire point. createPrivyEvmPort is right
      // here in lexical scope, so it is called directly.
      const { mountPrivyEvmIsland } = await import("./privy-evm-island");
      return createPrivyEvmPort({ island: await mountPrivyEvmIsland() });
    });
  const hasPersistedSession = deps.hasPersistedSession ?? hasPrivySession;
  const ensure = (): Promise<EvmWalletPort> => {
    if (inner) return Promise.resolve(inner);
    // Memoize the mount so concurrent callers share one island — but ONLY a successful one. A
    // cached REJECTED promise would outlive the island's own 25s-timeout retry reset and replay
    // the same failure for the rest of the session; since disconnect() always mounts, one slow
    // network could brick every later Sign-in tap. Clearing on rejection makes the next call retry.
    loading ??= (async () => {
      try {
        inner = await load();
        return inner;
      } catch (err) {
        inner = null;
        loading = null;
        throw err;
      }
    })();
    return loading;
  };
  return {
    kind: "privy-evm",
    async connect() {
      return (await ensure()).connect();
    },
    async reconnect() {
      // Boot-time silent restore. Skip mounting the island entirely unless Privy left a session
      // in localStorage — fresh visitors keep the react chunk out of their boot.
      if (!inner && !hasPersistedSession()) return null;
      return (await ensure()).reconnect();
    },
    async disconnect() {
      // Explicit logout must never trust the localStorage probe. Privy sessions can live in
      // cookies or IndexedDB, so mount the provider and ask Privy to clear its real auth state.
      await (await ensure()).disconnect();
    },
    currentAddress() {
      return inner?.currentAddress() ?? null;
    },
    async signMessage(message: string) {
      return (await ensure()).signMessage(message);
    },
    async sendUsdcTransfer(to: string, amountBaseUnits: bigint) {
      return (await ensure()).sendUsdcTransfer(to, amountBaseUnits);
    },
    async usdcBalance() {
      // A balance poll must not drag the Privy chunk into a signed-out boot.
      if (!inner) return null;
      return inner.usdcBalance();
    },
  };
}
