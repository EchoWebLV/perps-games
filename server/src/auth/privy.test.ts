import { describe, it, expect } from "vitest";
import { makePrivyAuth } from "./privy.js";

describe("makePrivyAuth", () => {
  it("returns null when keys are absent (Privy disabled)", () => {
    expect(makePrivyAuth({ PRIVY_APP_ID: undefined, PRIVY_APP_SECRET: undefined })).toBeNull();
  });
  it("returns an adapter with verify + wallet methods when keys are present", () => {
    const a = makePrivyAuth({ PRIVY_APP_ID: "cmtest", PRIVY_APP_SECRET: "sk" });
    expect(typeof a?.verifyAccessToken).toBe("function");
    expect(typeof a?.fetchSolanaWallet).toBe("function");
  });
});
