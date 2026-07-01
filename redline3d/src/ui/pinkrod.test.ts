import { describe, expect, it } from "vitest";
import { createAutoExitCore, SLS, TPS } from "./pinkrod";

describe("createAutoExitCore (Pink Rod Auto-Exit)", () => {
  it("defaults to both OFF → {0, 0} (identical to every non-Pink-Rod round)", () => {
    const core = createAutoExitCore();
    expect(core.values()).toEqual({ slFp: 0, tpFp: 0 });
    expect(core.slLabel()).toBe("OFF");
    expect(core.tpLabel()).toBe("OFF");
  });

  it("maps stop-loss indices to exact on-chain SCALE units", () => {
    const core = createAutoExitCore();
    core.setSl(SLS.indexOf(0.5) + 1); // slider 0 = OFF, 1.. = SLS[i-1]
    expect(core.values().slFp).toBe(500_000);
    expect(core.slLabel()).toBe("×0.5");
    core.setSl(1); // lowest stop, ×0.25 — above both possible liq floors
    expect(core.values().slFp).toBe(250_000);
    expect(core.slLabel()).toBe("×0.25");
  });

  it("maps take-profit indices to exact on-chain SCALE units", () => {
    const core = createAutoExitCore();
    core.setTp(TPS.indexOf(3)); // tp slider 0..TPS.length-1 = values, TPS.length = OFF
    expect(core.values().tpFp).toBe(3_000_000);
    expect(core.tpLabel()).toBe("×3");
    core.setTp(0); // quickest profit-take, ×1.5
    expect(core.values().tpFp).toBe(1_500_000);
    expect(core.tpLabel()).toBe("×1.5");
  });

  it("OFF positions (sl 0, tp last) return the program's unset sentinel 0", () => {
    const core = createAutoExitCore();
    core.setSl(3); core.setTp(2); // arm both…
    core.setSl(0); core.setTp(TPS.length); // …then slide back to OFF
    expect(core.values()).toEqual({ slFp: 0, tpFp: 0 });
    expect(core.slLabel()).toBe("OFF");
    expect(core.tpLabel()).toBe("OFF");
  });

  it("clamps out-of-range indices instead of crashing (defensive vs bad slider input)", () => {
    const core = createAutoExitCore();
    core.setSl(99); core.setTp(-5);
    expect(core.values().slFp).toBe(Math.round(SLS[SLS.length - 1] * 1_000_000));
    expect(core.values().tpFp).toBe(Math.round(TPS[0] * 1_000_000));
  });

  it("every UI stop stays inside the program clamps (SL above the 0.20 floor, TP below the ×25 cap)", () => {
    // If this fails, the UI can request a value the program would silently clamp — keep them aligned.
    for (const s of SLS) expect(s).toBeGreaterThan(0.2);
    for (const s of SLS) expect(s).toBeLessThan(1);
    for (const t of TPS) expect(t).toBeGreaterThan(1);
    for (const t of TPS) expect(t).toBeLessThan(25);
  });
});
