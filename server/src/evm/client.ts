import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
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

/** Treasury signer. The returned address is lowercased to match how env.ts stores EVM addresses. */
export function makeTreasuryWalletClient(cfg: { chainId: number; rpcUrl: string; secret: `0x${string}` }): {
  client: WalletClient;
  address: string;
} {
  const chain = defineEvmChain({ chainId: cfg.chainId, rpcUrl: cfg.rpcUrl });
  const account = privateKeyToAccount(cfg.secret);
  return {
    client: createWalletClient({ chain, account, transport: http(cfg.rpcUrl) }),
    address: account.address.toLowerCase(),
  };
}
