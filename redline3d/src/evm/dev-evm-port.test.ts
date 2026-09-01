import { describe, expect, it, vi } from "vitest";
import { erc20Abi, zeroAddress } from "viem";
import { createDevEvmPort, type DevEvmPortDeps } from "./dev-evm-port";

const KEY = ("0x" + "7".repeat(64)) as `0x${string}`;
// Mixed-case on purpose: the port must normalize the configured token address too.
const USDC = "0xAAbbCCddEEff00112233445566778899aAbBcCdD";
// All-caps recipient — viem 2.x rejects this at encode time (InvalidAddressError) unless
// the port lowercases it first, so it is the exact input that proves the normalization.
const TO_UPPER = "0xBBCCDDEEFF00112233445566778899AABBCCDDEE";
const TO_LOWER = "0xbbccddeeff00112233445566778899aabbccddee";

type WriteArgs = Parameters<NonNullable<DevEvmPortDeps["writeContract"]>>[0];
type ReadArgs = Parameters<NonNullable<DevEvmPortDeps["readContract"]>>[0];

const okWrite = () => vi.fn(async (_args: WriteArgs) => "0xdeadbeef" as `0x${string}`);

describe("createDevEvmPort", () => {
  it("derives a stable address and signs EIP-191", async () => {
    const port = createDevEvmPort(("0x" + "7".repeat(64)) as `0x${string}`);
    const { address } = await port.connect();
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    const sig = await port.signMessage("hello");
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  describe("with no key passed and none configured in the env", () => {
    // Construction must NEVER throw: a production build that loses VITE_PRIVY_APP_ID resolves the
    // wallet kind to "dev", and a throw at construction kills boot — including guest play, which
    // needs no wallet at all. The failure belongs at first USE.
    const bare = () => {
      vi.stubEnv("VITE_DEV_EVM_SECRET", "");
      try {
        return createDevEvmPort();
      } finally {
        vi.unstubAllEnvs();
      }
    };

    it("constructs without throwing, so boot survives", () => {
      expect(() => bare()).not.toThrow();
      expect(bare().kind).toBe("dev-evm");
    });

    it("has no address to report", () => {
      expect(bare().currentAddress()).toBeNull();
    });

    it("throws dev_evm_secret_missing on every action that needs the key", async () => {
      await expect(bare().connect()).rejects.toThrow("dev_evm_secret_missing");
      await expect(bare().reconnect()).rejects.toThrow("dev_evm_secret_missing");
      await expect(bare().signMessage("hi")).rejects.toThrow("dev_evm_secret_missing");
      await expect(bare().sendUsdcTransfer(TO_LOWER, 1n)).rejects.toThrow("dev_evm_secret_missing");
    });

    it("reports a null balance rather than throwing (the cashier shows a dash)", async () => {
      await expect(bare().usdcBalance()).resolves.toBeNull();
    });

    it("disconnect stays a no-op", async () => {
      await expect(bare().disconnect()).resolves.toBeUndefined();
    });
  });

  describe("sendUsdcTransfer", () => {
    it("encodes transfer([lowercased to, amount]) against the USDC contract", async () => {
      const writeContract = okWrite();
      const port = createDevEvmPort(KEY, { writeContract, usdcAddress: USDC });

      const hash = await port.sendUsdcTransfer(TO_UPPER, 1_500_000n);

      expect(hash).toBe("0xdeadbeef");
      expect(writeContract).toHaveBeenCalledTimes(1);
      const call = writeContract.mock.calls[0][0];
      expect(call.address).toBe(USDC.toLowerCase());
      expect(call.abi).toBe(erc20Abi);
      expect(call.functionName).toBe("transfer");
      expect(call.args).toEqual([TO_LOWER, 1_500_000n]);
    });

    it("refuses to burn: rejects the zero address before encoding", async () => {
      const writeContract = okWrite();
      const port = createDevEvmPort(KEY, { writeContract, usdcAddress: USDC });

      await expect(port.sendUsdcTransfer(zeroAddress, 1n)).rejects.toThrow("evm_transfer_to_zero");
      expect(writeContract).not.toHaveBeenCalled();
    });

    it("throws when the USDC contract address is unconfigured", async () => {
      const writeContract = okWrite();
      const port = createDevEvmPort(KEY, { writeContract, usdcAddress: "" });

      await expect(port.sendUsdcTransfer(TO_LOWER, 1n)).rejects.toThrow("evm_usdc_address_unset");
      expect(writeContract).not.toHaveBeenCalled();
    });
  });

  describe("usdcBalance", () => {
    it("reads balanceOf with the wallet's own lowercased address", async () => {
      const readContract = vi.fn(async (_args: ReadArgs) => 4_200_000n);
      const port = createDevEvmPort(KEY, { readContract, usdcAddress: USDC });

      await expect(port.usdcBalance()).resolves.toBe(4_200_000n);
      const call = readContract.mock.calls[0][0];
      expect(call.address).toBe(USDC.toLowerCase());
      expect(call.functionName).toBe("balanceOf");
      expect(call.args[0]).toBe(port.currentAddress());
      expect(call.args[0]).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it("resolves null rather than throwing when the RPC fails", async () => {
      const readContract = vi.fn(async (_args: ReadArgs) => {
        throw new Error("rpc down");
      });
      const port = createDevEvmPort(KEY, { readContract, usdcAddress: USDC });

      await expect(port.usdcBalance()).resolves.toBeNull();
    });

    it("resolves null when the USDC contract address is unconfigured", async () => {
      const port = createDevEvmPort(KEY, { usdcAddress: "" });
      await expect(port.usdcBalance()).resolves.toBeNull();
    });
  });
});
