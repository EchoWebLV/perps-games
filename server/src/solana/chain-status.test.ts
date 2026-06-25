import { describe, expect, it } from "vitest";
import { mapSignatureStatus } from "./chain-status.js";

describe("mapSignatureStatus", () => {
  it("maps a finalized, error-free status to 'finalized'", () => {
    expect(mapSignatureStatus({ confirmationStatus: "finalized", err: null })).toBe("finalized");
  });

  it("maps any landed error to 'failed' (even if finalized)", () => {
    expect(mapSignatureStatus({ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } })).toBe("failed");
    expect(mapSignatureStatus({ confirmationStatus: "confirmed", err: { foo: 1 } })).toBe("failed");
  });

  it("maps not-yet-finalized / missing status to 'unknown'", () => {
    expect(mapSignatureStatus({ confirmationStatus: "confirmed", err: null })).toBe("unknown");
    expect(mapSignatureStatus({ confirmationStatus: "processed", err: null })).toBe("unknown");
    expect(mapSignatureStatus(null)).toBe("unknown");
  });
});
