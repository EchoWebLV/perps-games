import { describe, it, expect, vi } from "vitest";
import { createPrivyPort } from "./privy-wallet-port";

describe("privy wallet port", () => {
  it("connect resolves the embedded address; signTransaction delegates to the island", async () => {
    const island = {
      connect: vi.fn(async () => "PrivyAddr1111"),
      signTransaction: vi.fn(async (b64: string) => b64 + ".signed"),
      currentAddress: () => "PrivyAddr1111",
    };
    const port = createPrivyPort({ island });
    const res = await port.connect();
    expect(res.address).toBe("PrivyAddr1111");
    expect(await port.signTransaction("dHg=")).toBe("dHg=.signed");
    expect(port.currentAddress()).toBe("PrivyAddr1111");
    expect(port.kind).toBe("web-standard");
  });
});
