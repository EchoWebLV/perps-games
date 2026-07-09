import { describe, it, expect } from "vitest";
import { reconcileFlip } from "./flip-reconcile";

describe("reconcileFlip (optimistic lane-bet/barrel-roll flip vs the confirmed chain round)", () => {
  it("reverts to the chain direction + entry when the background flip did NOT land", () => {
    // Local optimistically flipped to SHORT (-1); the on-chain flip failed, so the chain is still
    // LONG (1) at its original entry. The confirmed read wins → snap the HUD back to LONG.
    const fix = reconcileFlip(-1, { status: 1, dir: 1, entryHuman: 81 });
    expect(fix).toEqual({ dir: 1, entryPx: 81 });
  });

  it("is a no-op when the chain already holds the optimistic direction (the flip took)", () => {
    expect(reconcileFlip(-1, { status: 1, dir: -1, entryHuman: 81 })).toBeNull();
  });

  it("is a no-op when there is no live round to reconcile against (close() settles at chain truth)", () => {
    expect(reconcileFlip(-1, null)).toBeNull();
    expect(reconcileFlip(-1, { status: 2, dir: 1, entryHuman: 81 })).toBeNull(); // already settled
  });

  it("does not act on an unreadable direction (defensive — never snap to garbage)", () => {
    expect(reconcileFlip(1, { status: 1, dir: 0, entryHuman: 81 })).toBeNull();
  });

  it("reverts a LONG-optimistic flip that the chain reports as SHORT", () => {
    expect(reconcileFlip(1, { status: 1, dir: -1, entryHuman: 200 })).toEqual({ dir: -1, entryPx: 200 });
  });
});
