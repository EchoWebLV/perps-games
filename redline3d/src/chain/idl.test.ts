import { describe, it, expect } from "vitest";
import idl from "./idl/raider.json";

describe("raider IDL", () => {
  it("is the deployed program ABI with the round loop instructions", () => {
    expect(idl.address).toBe("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");
    const names = idl.instructions.map((i) => i.name);
    for (const ix of ["buy_in", "init_round", "delegate_session", "open", "close", "force_close", "commit_and_undelegate", "withdraw"]) {
      expect(names).toContain(ix);
    }
  });
});
