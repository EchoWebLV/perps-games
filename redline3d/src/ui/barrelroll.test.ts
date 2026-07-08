import { describe, expect, test } from "vitest";
import { createBarrelRollCore } from "./barrelroll";

describe("barrel roll button core (Helmet: manual flip, once per round)", () => {
  test("fires once, then is spent until the round ends", () => {
    const b = createBarrelRollCore();
    b.setEnabled(true);
    b.update(true);               // round live
    expect(b.fire()).toBe(true);  // first tap flips the trade + rolls the world
    expect(b.used).toBe(true);
    expect(b.fire()).toBe(false); // no second use this round — "like nitro but once"
  });

  test("can't fire unless enabled AND live; visible only when both", () => {
    const b = createBarrelRollCore();
    expect(b.fire()).toBe(false);  // not enabled (wrong car)
    b.setEnabled(true);
    b.update(false);               // parked / pre-round
    expect(b.fire()).toBe(false);
    expect(b.visible).toBe(false);
    b.update(true);
    expect(b.visible).toBe(true);
    expect(b.fire()).toBe(true);
  });

  test("a new round re-arms the single use", () => {
    const b = createBarrelRollCore();
    b.setEnabled(true);
    b.update(true); b.fire();
    expect(b.used).toBe(true);
    b.update(false);   // round ended
    b.update(true);    // next round live
    expect(b.used).toBe(false);
    expect(b.fire()).toBe(true);
  });

  test("switching cars (disable) clears the spent flag", () => {
    const b = createBarrelRollCore();
    b.setEnabled(true); b.update(true); b.fire();
    b.setEnabled(false);           // picked another car
    b.setEnabled(true); b.update(true);
    expect(b.fire()).toBe(true);
  });
});
