import { describe, expect, it } from "vitest";
import { resolveEvmChain } from "./chain";

describe("resolveEvmChain", () => {
  it("mainnet by default; testnet on VITE_EVM_CHAIN=testnet", () => {
    expect(resolveEvmChain({}).id).toBe(4663);
    expect(resolveEvmChain({ VITE_EVM_CHAIN: "testnet" }).id).toBe(46630);
    expect(resolveEvmChain({}).rpcUrls.default.http[0]).toBe("https://rpc.mainnet.chain.robinhood.com");
  });
});
