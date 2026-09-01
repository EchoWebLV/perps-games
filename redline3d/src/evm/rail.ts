import { createDevEvmPort } from "./dev-evm-port";
import { createLazyPrivyEvmPort } from "./privy-evm-port";
import type { EvmWalletPort } from "./wallet-port";

/**
 * Which chain the client talks to. The EVM rail (Robinhood Chain) is the live money rail; the
 * Solana rail is parked but still buildable, so the switch is a runtime resolution rather than a
 * deleted code path. Resolution order mirrors chain/wallet-select.ts:
 *   1. `?rail=evm|solana` URL param — runtime escape hatch for Preview / automation.
 *   2. `VITE_CHAIN_RAIL` env (build-time pin).
 *   3. Default: evm.
 */
export type ChainRail = "evm" | "solana";

export function resolveChainRail(env: { VITE_CHAIN_RAIL?: string }, search: string): ChainRail {
  const param = new URLSearchParams(search).get("rail");
  if (param === "evm" || param === "solana") return param;
  return env.VITE_CHAIN_RAIL === "solana" ? "solana" : "evm";
}

/**
 * Which EVM signer to use — the exact resolution order chain/wallet-select.ts uses for Solana:
 *   1. `?wallet=dev|privy` URL param.
 *   2. `VITE_WALLET` env.
 *   3. Default: privy whenever a Privy app id is configured (the player path), else the dev key.
 */
export type EvmWalletKind = "privy" | "dev";

export function resolveEvmWalletKind(
  env: { VITE_WALLET?: string; VITE_PRIVY_APP_ID?: string },
  search: string,
): EvmWalletKind {
  const param = new URLSearchParams(search).get("wallet");
  if (param === "dev" || param === "privy") return param;
  if (env.VITE_WALLET === "privy") return "privy";
  if (env.VITE_WALLET === "dev") return "dev";
  return env.VITE_PRIVY_APP_ID ? "privy" : "dev";
}

/**
 * Read the vite env as EXACT `import.meta.env.VITE_*` member accesses — that literal form is what
 * vite static-replaces at transform. Passing `import.meta.env` whole references the injected
 * bare-env object, which ships EMPTY in some production chunks (see chain/wallet-select.ts). The
 * try/catch keeps this module importable from non-vite contexts.
 */
function viteRailEnv(): { VITE_CHAIN_RAIL?: string; VITE_WALLET?: string; VITE_PRIVY_APP_ID?: string } {
  try {
    return {
      VITE_CHAIN_RAIL: import.meta.env.VITE_CHAIN_RAIL as string | undefined,
      VITE_WALLET: import.meta.env.VITE_WALLET as string | undefined,
      VITE_PRIVY_APP_ID: import.meta.env.VITE_PRIVY_APP_ID as string | undefined,
    };
  } catch {
    return {};
  }
}

/** The chain rail this build runs on. */
export function currentChainRail(): ChainRail {
  return resolveChainRail(viteRailEnv(), globalThis.location?.search ?? "");
}

/**
 * Pick the EVM signer. Returns synchronously so boot needs no async restructuring: for Privy the
 * React island is dynamic-imported and mounted LAZILY on the first connect(), keeping it out of
 * the default bundle and out of the path entirely when the dev port is picked. The creators are
 * injectable so the selection can be tested without a Privy app id or a dev secret.
 */
export function selectEvmWalletPort(
  deps: {
    env?: { VITE_WALLET?: string; VITE_PRIVY_APP_ID?: string };
    search?: string;
    createDev?: () => EvmWalletPort;
    createPrivy?: () => EvmWalletPort;
  } = {},
): EvmWalletPort {
  const kind = resolveEvmWalletKind(deps.env ?? viteRailEnv(), deps.search ?? globalThis.location?.search ?? "");
  if (kind === "privy") return (deps.createPrivy ?? (() => createLazyPrivyEvmPort()))();
  return (deps.createDev ?? (() => createDevEvmPort()))();
}
