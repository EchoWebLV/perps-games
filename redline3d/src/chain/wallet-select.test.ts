import { describe, it, expect } from "vitest";
import { resolveWalletKind } from "./wallet-select";

describe("resolveWalletKind", () => {
  it("defaults to privy when a Privy app id is configured (the player path)", () => {
    expect(resolveWalletKind({ VITE_PRIVY_APP_ID: "app123" }, "")).toBe("privy");
  });

  it("defaults to dev-keypair when no Privy app id exists", () => {
    expect(resolveWalletKind({}, "")).toBe("dev");
  });

  it("VITE_WALLET overrides the app-id default", () => {
    expect(resolveWalletKind({ VITE_WALLET: "dev", VITE_PRIVY_APP_ID: "app123" }, "")).toBe("dev");
    expect(resolveWalletKind({ VITE_WALLET: "privy" }, "")).toBe("privy");
  });

  it("?wallet= URL param wins over everything (Preview/automation escape hatch)", () => {
    expect(resolveWalletKind({ VITE_WALLET: "privy", VITE_PRIVY_APP_ID: "app123" }, "?wallet=dev")).toBe("dev");
    expect(resolveWalletKind({ VITE_WALLET: "dev" }, "?wallet=privy")).toBe("privy");
  });

  it("ignores unknown ?wallet= values", () => {
    expect(resolveWalletKind({ VITE_PRIVY_APP_ID: "app123" }, "?wallet=bogus")).toBe("privy");
  });
});
