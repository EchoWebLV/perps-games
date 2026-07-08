import { describe, expect, test } from "vitest";
import { createMagnetCore, MAGNET_ACTIVE, MAGNET_COOLDOWN } from "./magnet";

describe("coin magnet core (Magnet)", () => {
  test("vacuums for ~4s, then cools down nitro-style and can fire again in the same round", () => {
    const m = createMagnetCore();
    m.setEnabled(true);

    expect(m.update(0.1, true)).toBe(false);                // live + ready → not vacuuming
    expect(m.fire()).toBe(true);                            // engage the vacuum
    expect(m.update(0.1, true)).toBe(true);                 // vacuuming
    expect(m.update(MAGNET_ACTIVE - 0.5, true)).toBe(true); // still on near the end
    expect(m.update(0.6, true)).toBe(false);                // window over → off
    expect(m.phase).toBe("cool");

    // cooling: no re-fire yet
    expect(m.fire()).toBe(false);
    expect(m.update(MAGNET_COOLDOWN - 0.5, true)).toBe(false);
    expect(m.phase).toBe("cool");

    // cooldown over → ready again — NOT once per round
    m.update(0.6, true);
    expect(m.phase).toBe("ready");
    expect(m.fire()).toBe(true);
    expect(m.update(0.1, true)).toBe(true);
  });

  test("only fires when enabled AND a round is live; a round end re-arms it", () => {
    const m = createMagnetCore();
    expect(m.fire()).toBe(false);              // disabled → no fire
    m.setEnabled(true);
    expect(m.update(0.1, false)).toBe(false);  // not live
    expect(m.fire()).toBe(false);              // still can't fire when not live
    m.update(0.1, true);                       // now live
    expect(m.fire()).toBe(true);
    m.update(MAGNET_ACTIVE + 0.1, true);       // burn through the active window → cool
    expect(m.phase).toBe("cool");
    m.update(0.1, false);                      // round ended mid-cooldown
    expect(m.phase).toBe("ready");             // re-armed for the next round
  });

  test("disabling (non-magnet car) resets to ready and stops vacuuming", () => {
    const m = createMagnetCore();
    m.setEnabled(true);
    m.update(0.1, true);
    m.fire();
    expect(m.update(0.1, true)).toBe(true);    // active
    m.setEnabled(false);                       // switch to a different car
    expect(m.phase).toBe("ready");
    expect(m.update(0.1, true)).toBe(false);   // no longer vacuuming
  });
});
