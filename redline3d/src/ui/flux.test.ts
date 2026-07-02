import { describe, expect, test } from "vitest";
import { createFluxCore, FLUX_ACTIVE, FLUX_LEV } from "./flux";

describe("flux brake core (DeLorean)", () => {
  test("freezes for ~4s, then is spent for the rest of the round (no re-fire)", () => {
    const f = createFluxCore();
    f.setEnabled(true);

    expect(f.update(0.1, true)).toBe(false);      // live + ready → not frozen
    expect(f.fire()).toBe(true);                  // engage the flux brake
    expect(f.update(0.1, true)).toBe(true);       // frozen
    expect(f.update(FLUX_ACTIVE - 0.5, true)).toBe(true); // still frozen near the end
    expect(f.update(0.6, true)).toBe(false);      // window over → unfrozen
    expect(f.phase).toBe("spent");

    // once per round: no re-fire while spent
    expect(f.fire()).toBe(false);
    expect(f.update(5, true)).toBe(false);
    expect(f.phase).toBe("spent");
  });

  test("a new round re-arms it", () => {
    const f = createFluxCore();
    f.setEnabled(true);
    f.update(0.1, true); f.fire();
    f.update(FLUX_ACTIVE + 1, true);
    expect(f.phase).toBe("spent");
    f.update(0.1, false);                         // round ended
    f.update(0.1, true);                          // next round live
    expect(f.phase).toBe("ready");
    expect(f.fire()).toBe(true);
  });

  test("a round ending mid-freeze unfreezes and re-arms", () => {
    const f = createFluxCore();
    f.setEnabled(true);
    f.update(0.1, true); f.fire();
    expect(f.update(0.1, true)).toBe(true);
    expect(f.update(0.1, false)).toBe(false);     // settle mid-freeze → off
    expect(f.phase).toBe("ready");
  });

  test("can't fire unless enabled AND live; visible only when both", () => {
    const f = createFluxCore();
    expect(f.fire()).toBe(false);                 // not enabled
    f.setEnabled(true);
    f.update(0.1, false);
    expect(f.fire()).toBe(false);                 // enabled but parked
    expect(f.visible).toBe(false);
    f.update(0.1, true);
    expect(f.visible).toBe(true);
  });

  test("the freeze leverage is the program minimum", () => {
    expect(FLUX_LEV).toBe(10); // on-chain RMIN — ~zero price impact next to 2000×
  });
});
