import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { defineEvmChain, makePublicClient, makeTreasuryWalletClient } from "./client.js";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const RPC_FALLBACK = "https://rpc2.mainnet.chain.robinhood.com";
// Test-only throwaway key. Never a real treasury secret.
const SECRET = `0x${"11".repeat(32)}` as const;

describe("defineEvmChain", () => {
  it("builds a viem chain from env values", () => {
    const chain = defineEvmChain({ chainId: 4663, rpcUrl: RPC });
    expect(chain.id).toBe(4663);
    expect(chain.rpcUrls.default.http[0]).toBe(RPC);
    expect(chain.nativeCurrency.symbol).toBe("ETH");
  });

  it("names chain 4663 Robinhood Chain and falls back to a generic name elsewhere", () => {
    expect(defineEvmChain({ chainId: 4663, rpcUrl: RPC }).name).toBe("Robinhood Chain");
    expect(defineEvmChain({ chainId: 8453, rpcUrl: RPC }).name).toBe("evm-8453");
  });
});

describe("makePublicClient", () => {
  it("carries the configured chain", () => {
    const client = makePublicClient({ chainId: 4663, rpcUrl: RPC });
    expect(client.chain?.id).toBe(4663);
  });

  it("builds a fallback transport when a fallback RPC is configured", () => {
    const client = makePublicClient({ chainId: 4663, rpcUrl: RPC, rpcUrlFallback: RPC_FALLBACK });
    expect(client.transport.type).toBe("fallback");
    expect(makePublicClient({ chainId: 4663, rpcUrl: RPC }).transport.type).toBe("http");
  });
});

describe("makeTreasuryWalletClient", () => {
  it("derives the signer address from the secret and lowercases it", () => {
    const expected = privateKeyToAccount(SECRET).address;
    const { client, address } = makeTreasuryWalletClient({ chainId: 4663, rpcUrl: RPC, secret: SECRET });
    expect(address).toBe(expected.toLowerCase());
    expect(address).toBe(address.toLowerCase()); // stored lowercased, as env.ts does
    expect(client.account?.address).toBe(expected);
    expect(client.chain?.id).toBe(4663);
  });
});

// Compile-time regression guard, never executed: a bare `WalletClient` return annotation erases the
// bound account and chain, so this call fails TS2345 demanding an explicit `account`/`chain`.
// The inferred return type keeps the binding. Type-checked by `npm run build`.
async function _sendsWithoutRestatingTheAccount() {
  const { client } = makeTreasuryWalletClient({ chainId: 4663, rpcUrl: RPC, secret: SECRET });
  await client.sendTransaction({ to: `0x${"22".repeat(20)}`, value: 1n });
}
