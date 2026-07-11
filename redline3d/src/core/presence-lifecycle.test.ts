import { describe, expect, it } from "vitest";
import { presenceHudShouldShow, presenceShouldConnect } from "./presence-lifecycle";

describe("presence lifecycle", () => {
  it("connects in social driving modes after identity is available", () => {
    expect(presenceShouldConnect({ mode: "lobby", hasIdentity: true })).toBe(true);
    expect(presenceShouldConnect({ mode: "highway", hasIdentity: true })).toBe(true);
    expect(presenceShouldConnect({ mode: "race", hasIdentity: true })).toBe(false);
    expect(presenceShouldConnect({ mode: "lobby", hasIdentity: false })).toBe(false);
    expect(presenceShouldConnect({ mode: "highway", hasIdentity: false })).toBe(false);
  });

  it("keeps emote chrome in the lobby while Highway presence stays connected", () => {
    expect(presenceHudShouldShow("lobby")).toBe(true);
    expect(presenceHudShouldShow("highway")).toBe(false);
  });
});
