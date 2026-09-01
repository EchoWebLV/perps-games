import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, zeroAddress } from "viem";
import { buildPersonalSignParams, buildUsdcTransferTx, ensureChain, utf8ToHex } from "./eip1193";

const FROM = "0x1111111111111111111111111111111111111111";
// Mixed case on purpose: viem 2.x is EIP-55 strict, so a non-checksummed mixed-case address
// throws at encode time unless the builder lowercases it first.
const TO_UPPER = "0xBBCCDDEEFF00112233445566778899AABBCCDDEE";
const TO_LOWER = "0xbbccddeeff00112233445566778899aabbccddee";
const USDC_UPPER = "0xAAbbCCddEEff00112233445566778899aAbBcCdD";
const USDC_LOWER = "0xaabbccddeeff00112233445566778899aabbccdd";
const CHAIN_ID = 4663;

interface Call {
  method: string;
  params?: unknown[];
}

/** Minimal EIP-1193 double. `chainIds` is consumed one entry per eth_chainId read (last repeats). */
function fakeProvider(opts: {
  chainIds?: string[];
  chainIdThrows?: boolean;
  switchRejects?: boolean;
}) {
  const calls: Call[] = [];
  const ids = opts.chainIds ?? [];
  let reads = 0;
  return {
    calls,
    request: async (r: Call) => {
      calls.push(r);
      if (r.method === "eth_chainId") {
        if (opts.chainIdThrows) throw new Error("provider_disconnected");
        return ids[Math.min(reads++, ids.length - 1)];
      }
      if (r.method === "wallet_switchEthereumChain") {
        if (opts.switchRejects) throw new Error("user rejected chain switch");
        return null;
      }
      throw new Error(`unexpected ${r.method}`);
    },
  };
}

describe("utf8ToHex", () => {
  it("round-trips a plain ASCII message", () => {
    expect(utf8ToHex("hi")).toBe("0x6869");
  });

  it("encodes multibyte UTF-8 by BYTES, not code units", () => {
    // "é" = C3 A9, "→" = E2 86 92, "𝄞" = F0 9D 84 9E (surrogate pair in JS)
    const hex = utf8ToHex("é→𝄞");
    expect(hex).toBe("0xc3a9e28692f09d849e");
    const bytes = Uint8Array.from(
      (hex.slice(2).match(/../g) ?? []).map((b) => Number.parseInt(b, 16)),
    );
    expect(new TextDecoder().decode(bytes)).toBe("é→𝄞");
  });

  it("pads single-digit bytes to two nibbles", () => {
    expect(utf8ToHex(String.fromCharCode(10))).toBe("0x0a");
  });

  it("encodes the real multi-line bind challenge byte-for-byte", () => {
    const message = ["Perps Rider wallet binding", "Wallet: 0xabc", "Nonce: 1"].join(String.fromCharCode(10));
    const hex = utf8ToHex(message);
    const bytes = Uint8Array.from(
      (hex.slice(2).match(/../g) ?? []).map((b) => Number.parseInt(b, 16)),
    );
    expect(new TextDecoder().decode(bytes)).toBe(message);
  });

  it("encodes the empty string as bare 0x", () => {
    expect(utf8ToHex("")).toBe("0x");
  });
});

describe("buildPersonalSignParams", () => {
  it("puts the hex MESSAGE first and the address second (personal_sign order)", () => {
    const params = buildPersonalSignParams("bind me", FROM);
    expect(params).toEqual(["0x62696e64206d65", FROM]);
    // order is the whole point: [address, data] is eth_sign's order and would sign garbage
    expect(params[0].startsWith("0x62")).toBe(true);
    expect(params[1]).toBe(FROM);
  });
});

describe("buildUsdcTransferTx", () => {
  it("emits exactly {from,to,data,chainId} with the USDC contract as `to`", () => {
    const tx = buildUsdcTransferTx({
      from: FROM,
      to: TO_UPPER,
      usdc: USDC_UPPER,
      amountBaseUnits: 1_500_000n,
      chainId: CHAIN_ID,
    });

    expect(Object.keys(tx).sort()).toEqual(["chainId", "data", "from", "to"]);
    expect(tx.from).toBe(FROM);
    expect(tx.to).toBe(USDC_LOWER); // lowercased: viem/EIP-55 strictness AND provider parity
    expect(tx.chainId).toBe(CHAIN_ID);
  });

  it("encodes transfer(recipient, amount) with the recipient LOWERCASED", () => {
    const tx = buildUsdcTransferTx({
      from: FROM,
      to: TO_UPPER,
      usdc: USDC_LOWER,
      amountBaseUnits: 1_500_000n,
      chainId: CHAIN_ID,
    });

    expect(tx.data.startsWith("0xa9059cbb")).toBe(true); // transfer(address,uint256)
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("transfer");
    // viem decodes to the EIP-55 checksummed form, so compare case-folded
    expect((decoded.args?.[0] as string).toLowerCase()).toBe(TO_LOWER);
    expect(decoded.args?.[1]).toBe(1_500_000n);
  });

  it("refuses to burn: the zero address throws before anything is encoded", () => {
    expect(() =>
      buildUsdcTransferTx({
        from: FROM,
        to: zeroAddress,
        usdc: USDC_LOWER,
        amountBaseUnits: 1n,
        chainId: CHAIN_ID,
      }),
    ).toThrow("evm_transfer_to_zero");
  });

  it("throws when the USDC contract address is unconfigured", () => {
    expect(() =>
      buildUsdcTransferTx({
        from: FROM,
        to: TO_LOWER,
        usdc: "",
        amountBaseUnits: 1n,
        chainId: CHAIN_ID,
      }),
    ).toThrow("evm_usdc_address_unset");
  });

  it("checks the recipient BEFORE the build config (the actionable error wins)", () => {
    expect(() =>
      buildUsdcTransferTx({
        from: FROM,
        to: zeroAddress,
        usdc: "",
        amountBaseUnits: 1n,
        chainId: CHAIN_ID,
      }),
    ).toThrow("evm_transfer_to_zero");
  });
});

describe("ensureChain", () => {
  it("already on the chain: reads once and never asks to switch", async () => {
    const p = fakeProvider({ chainIds: ["0x1237"] }); // 4663
    await expect(ensureChain(p, CHAIN_ID)).resolves.toBeUndefined();
    expect(p.calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });

  it("wrong chain then a successful switch resolves", async () => {
    const p = fakeProvider({ chainIds: ["0x1", "0x1237"] });
    await expect(ensureChain(p, CHAIN_ID)).resolves.toBeUndefined();
    expect(p.calls.map((c) => c.method)).toEqual([
      "eth_chainId",
      "wallet_switchEthereumChain",
      "eth_chainId",
    ]);
    expect(p.calls[1].params).toEqual([{ chainId: "0x1237" }]);
  });

  it("wrong chain and a REJECTED switch fails closed with evm_wrong_chain", async () => {
    const p = fakeProvider({ chainIds: ["0x1"], switchRejects: true });
    await expect(ensureChain(p, CHAIN_ID)).rejects.toThrow("evm_wrong_chain");
  });

  it("a switch that resolves but leaves the wrong chain still fails closed", async () => {
    const p = fakeProvider({ chainIds: ["0x1", "0x1"] });
    await expect(ensureChain(p, CHAIN_ID)).rejects.toThrow("evm_wrong_chain");
  });

  it("propagates an eth_chainId failure rather than assuming the chain is right", async () => {
    const p = fakeProvider({ chainIdThrows: true });
    await expect(ensureChain(p, CHAIN_ID)).rejects.toThrow("provider_disconnected");
  });

  it("a non-string eth_chainId is treated as wrong, not as a match", async () => {
    const p = fakeProvider({ chainIds: [4663 as unknown as string] });
    await expect(ensureChain(p, CHAIN_ID)).rejects.toThrow("evm_wrong_chain");
  });
});
