import { defineChain, type Chain } from "viem";

// Robinhood Chain (EVM L2). Mainnet is the default rail; the testnet is opt-in via
// VITE_EVM_CHAIN=testnet so a dev build can point at play money without a code change.
const MAINNET = { id: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" };
const TESTNET = { id: 46630, rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com" };

/** Pure resolver — takes the env slice so tests can pick a network without touching import.meta. */
export function resolveEvmChain(env: { VITE_EVM_CHAIN?: string }): Chain {
  const net = env.VITE_EVM_CHAIN === "testnet" ? TESTNET : MAINNET;
  return defineChain({
    id: net.id,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [net.rpc] } },
    blockExplorers: { default: { name: "Blockscout", url: net.explorer } },
  });
}

/**
 * Read the vite env as EXACT `import.meta.env.VITE_*` member accesses — that literal form is
 * what vite static-replaces at transform. Optional chaining, a cast around `import.meta`, or
 * passing `import.meta.env` whole all defeat the replacement (and the injected bare-env object
 * is EMPTY in some production chunks — see chain/wallet-select.ts). The try/catch keeps this
 * module importable from non-vite contexts (plain node scripts), where it falls through to {}.
 */
function viteEvmEnv(): { VITE_EVM_CHAIN?: string; VITE_EVM_USDC_ADDRESS?: string } {
  try {
    return {
      VITE_EVM_CHAIN: import.meta.env.VITE_EVM_CHAIN as string | undefined,
      VITE_EVM_USDC_ADDRESS: import.meta.env.VITE_EVM_USDC_ADDRESS as string | undefined,
    };
  } catch {
    return {};
  }
}

const ENV = viteEvmEnv();

/** The chain this build talks to. */
export const EVM_CHAIN: Chain = resolveEvmChain(ENV);

/** ERC-20 USDC contract on {@link EVM_CHAIN}, lowercased. Empty string when unconfigured. */
export const EVM_USDC = (ENV.VITE_EVM_USDC_ADDRESS ?? "").toLowerCase();
