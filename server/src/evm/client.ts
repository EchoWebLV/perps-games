import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Robinhood Chain (and any sibling EVM) described purely by env values — no hardcoded chain registry. */
export function defineEvmChain(cfg: { chainId: number; rpcUrl: string }): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 4663 ? "Robinhood Chain" : `evm-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

/** Read-side client. A configured fallback RPC becomes a viem `fallback` transport. */
export function makePublicClient(cfg: { chainId: number; rpcUrl: string; rpcUrlFallback?: string }): PublicClient {
  const chain = defineEvmChain(cfg);
  const transport = cfg.rpcUrlFallback ? fallback([http(cfg.rpcUrl), http(cfg.rpcUrlFallback)]) : http(cfg.rpcUrl);
  return createPublicClient({ chain, transport });
}

/**
 * Treasury signer. The returned address is lowercased to match how env.ts stores EVM addresses.
 *
 * The return type is inferred deliberately: annotating `client` as a bare `WalletClient` erases the
 * bound account and chain, and every call site would then have to restate `account` on each write.
 */
export function makeTreasuryWalletClient(cfg: { chainId: number; rpcUrl: string; secret: `0x${string}` }) {
  const chain = defineEvmChain({ chainId: cfg.chainId, rpcUrl: cfg.rpcUrl });
  const account = privateKeyToAccount(cfg.secret);
  return {
    client: createWalletClient({ chain, account, transport: http(cfg.rpcUrl) }),
    address: account.address.toLowerCase(),
  };
}

/** Spellable name for the inferred, account-and-chain-bound treasury signer. */
export type TreasuryWalletClient = ReturnType<typeof makeTreasuryWalletClient>["client"];
