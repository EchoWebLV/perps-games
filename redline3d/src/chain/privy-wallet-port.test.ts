import { describe, it, expect, vi } from "vitest";
import { createPrivyPort } from "./privy-wallet-port";

function fakeIsland() {
  let addr: string | null = "PrivyAddr1111";
  return {
    connect: vi.fn(async () => "PrivyAddr1111"),
    signTransaction: vi.fn(async (b64: string) => b64 + ".signed"),
    currentAddress: () => addr,
    logout: vi.fn(async () => { addr = null; }),
  };
}

describe("privy wallet port", () => {
  it("connect resolves the embedded address; signTransaction delegates to the island", async () => {
    const island = fakeIsland();
    const port = createPrivyPort({ island });
    const res = await port.connect();
    expect(res.address).toBe("PrivyAddr1111");
    expect(await port.signTransaction("dHg=")).toBe("dHg=.signed");
    expect(port.currentAddress()).toBe("PrivyAddr1111");
    expect(port.kind).toBe("web-standard");
  });

  it("disconnect logs out of Privy and drops the cached address", async () => {
    const island = fakeIsland();
    const port = createPrivyPort({ island });
    await port.connect();
    await port.disconnect();
    expect(island.logout).toHaveBeenCalled();
    expect(port.currentAddress()).toBe(null);
  });
});
