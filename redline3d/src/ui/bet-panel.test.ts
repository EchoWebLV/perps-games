// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createBetPanel } from "./bet-panel";

describe("betPanel.credit", () => {
  it("adds owner winnings to the wallet and reports them in results", () => {
    const el = document.createElement("div");
    const panel = createBetPanel(el);
    const before = panel.wallet();
    panel.credit(2.5, "Podium — P1");
    expect(panel.wallet()).toBeCloseTo(before + 2.5, 2);
    // The credit line is part of the FINISH results card, so drive the panel there
    // before asserting on user-visible DOM text (settle card is hidden otherwise).
    panel.render({ phase: "FINISH", marketRemaining: 0, raceLeaderName: null });
    expect(el.textContent).toContain("Podium — P1");
    panel.dispose();
  });
  it("ignores non-positive credits", () => {
    const el = document.createElement("div");
    const panel = createBetPanel(el);
    const before = panel.wallet();
    panel.credit(0, "nothing");
    panel.credit(-5, "nothing");
    expect(panel.wallet()).toBe(before);
    panel.dispose();
  });
});
