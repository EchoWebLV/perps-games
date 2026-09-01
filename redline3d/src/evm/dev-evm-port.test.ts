import { describe, expect, it } from "vitest";
import { createDevEvmPort } from "./dev-evm-port";

describe("createDevEvmPort", () => {
  it("derives a stable address and signs EIP-191", async () => {
    const port = createDevEvmPort(("0x" + "7".repeat(64)) as `0x${string}`);
    const { address } = await port.connect();
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    const sig = await port.signMessage("hello");
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });
});
