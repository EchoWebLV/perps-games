import { describe, expect, it } from "vitest";
import { presenceShouldConnect } from "./presence-lifecycle";

describe("presence lifecycle", () => {
  it("connects only in the lobby after identity is available", () => {
    expect(presenceShouldConnect({ mode: "lobby", hasIdentity: true })).toBe(true);
    expect(presenceShouldConnect({ mode: "race", hasIdentity: true })).toBe(false);
    expect(presenceShouldConnect({ mode: "lobby", hasIdentity: false })).toBe(false);
  });
});
