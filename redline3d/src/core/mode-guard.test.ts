import { describe, it, expect } from "vitest";
import { modeSwitchBlocked } from "./mode-guard";

describe("modeSwitchBlocked", () => {
  it("blocks while a GO is in flight, even though the engine is still idle (the launch race)", () => {
    // GO pressed → ensureSession/open in flight for seconds on devnet: phase "idle",
    // no local round yet. MAP must not pull the player into the lobby here, or the
    // open resolves into a live money round nobody can see.
    expect(modeSwitchBlocked({ opening: true, phase: "idle" })).toBe(true);
    expect(modeSwitchBlocked({ opening: true, phase: "idle", roundActive: false })).toBe(true);
  });

  it("blocks during a live round", () => {
    expect(modeSwitchBlocked({ opening: false, phase: "live" })).toBe(true);
  });

  it("blocks while a round is still open locally (settle not finalized)", () => {
    expect(modeSwitchBlocked({ opening: false, phase: "settled", roundActive: true })).toBe(true);
  });

  it("allows switching when idle with nothing in flight", () => {
    expect(modeSwitchBlocked({ opening: false, phase: "idle", roundActive: false })).toBe(false);
    expect(modeSwitchBlocked({ opening: false, phase: "idle" })).toBe(false);
    expect(modeSwitchBlocked({ opening: false, phase: "settled", roundActive: false })).toBe(false);
    expect(modeSwitchBlocked({ opening: false, phase: "liquidated", roundActive: false })).toBe(false);
  });
});
