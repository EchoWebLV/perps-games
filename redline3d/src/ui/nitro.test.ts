import { describe, expect, test } from "vitest";
import { createNitroCore, NITRO_MULT } from "./nitro";

describe("nitro overdrive core", () => {
  test("fires 2× for ~3s, then cools down, then re-arms", () => {
    const n = createNitroCore();
    n.setEnabled(true);

    expect(n.update(0.1, true)).toBe(1);          // live + ready → no boost
    expect(n.fire()).toBe(true);                  // fire
    expect(n.update(0.1, true)).toBe(NITRO_MULT); // active → 2×
    expect(n.update(2.5, true)).toBe(NITRO_MULT); // still active at ~2.6s
    expect(n.update(0.6, true)).toBe(NITRO_MULT); // boundary still boosts, then flips to cooldown
    expect(n.phase).toBe("cool");
    expect(n.update(0.1, true)).toBe(1);          // cooldown → back to 1×

    // a fire during cooldown is rejected
    expect(n.fire()).toBe(false);
    expect(n.update(0.1, true)).toBe(1);

    // after the full cooldown it re-arms and fires again
    n.update(6, true);
    expect(n.phase).toBe("ready");
    expect(n.fire()).toBe(true);
    expect(n.update(0.1, true)).toBe(NITRO_MULT);
  });

  test("can't fire unless enabled AND live", () => {
    const n = createNitroCore();
    expect(n.fire()).toBe(false);                 // not enabled
    n.setEnabled(true);
    n.update(0.1, false);
    expect(n.fire()).toBe(false);                 // enabled but parked
  });

  test("a round ending mid-burst resets the boost", () => {
    const n = createNitroCore();
    n.setEnabled(true);
    n.update(0.1, true); n.fire();
    expect(n.update(0.1, true)).toBe(NITRO_MULT); // boosting
    expect(n.update(0.1, false)).toBe(1);         // round ended → reset
    expect(n.update(0.1, true)).toBe(1);          // stays idle until fired again
  });

  test("visible only when enabled and live", () => {
    const n = createNitroCore();
    n.update(0.1, false); expect(n.visible).toBe(false);
    n.setEnabled(true);
    n.update(0.1, false); expect(n.visible).toBe(false);
    n.update(0.1, true);  expect(n.visible).toBe(true);
  });
});
