import { describe, expect, it } from "vitest";
import { resolveEvmChain } from "./chain";

describe("resolveEvmChain", () => {
  it("mainnet by default; testnet on VITE_EVM_CHAIN=testnet", () => {
    expect(resolveEvmChain({}).id).toBe(4663);
    expect(resolveEvmChain({ VITE_EVM_CHAIN: "testnet" }).id).toBe(46630);
    expect(resolveEvmChain({}).rpcUrls.default.http[0]).toBe("https://rpc.mainnet.chain.robinhood.com");
  });

  it("points each network at its own RPC and explorer", () => {
    expect(resolveEvmChain({ VITE_EVM_CHAIN: "testnet" }).rpcUrls.default.http[0]).toBe(
      "https://rpc.testnet.chain.robinhood.com",
    );
    expect(resolveEvmChain({}).blockExplorers?.default.url).toBe("https://robinhoodchain.blockscout.com");
    expect(resolveEvmChain({ VITE_EVM_CHAIN: "testnet" }).blockExplorers?.default.url).toBe(
      "https://explorer.testnet.chain.robinhood.com",
    );
  });

  it("treats any other VITE_EVM_CHAIN value as mainnet", () => {
    expect(resolveEvmChain({ VITE_EVM_CHAIN: "" }).id).toBe(4663);
    expect(resolveEvmChain({ VITE_EVM_CHAIN: "mainnet" }).id).toBe(4663);
    expect(resolveEvmChain({ VITE_EVM_CHAIN: "Testnet" }).id).toBe(4663);
  });
});
