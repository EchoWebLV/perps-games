import { describe, expect, it } from "vitest";
import { stepPlay, DEFAULT_PLAY_CAP } from "./controls";

describe("stepPlay (play-amount stepper, 0.01-SOL units)", () => {
  it("steps within [1, cap] and clamps at both ends", () => {
    expect(stepPlay(5, 1, DEFAULT_PLAY_CAP)).toBe(6);
    expect(stepPlay(DEFAULT_PLAY_CAP, 1, DEFAULT_PLAY_CAP)).toBe(DEFAULT_PLAY_CAP); // 0.10 SOL ceiling
    expect(stepPlay(1, -1, DEFAULT_PLAY_CAP)).toBe(1); // 0.01 SOL floor
  });

  it("a raised cap (Six Wheeler Heavy Load) lets the bet climb past the default", () => {
    expect(stepPlay(DEFAULT_PLAY_CAP, 1, 25)).toBe(11);
    expect(stepPlay(25, 1, 25)).toBe(25);
  });

  it("clamps an oversized bet back down when the cap shrinks (car switched away)", () => {
    expect(stepPlay(25, 1, DEFAULT_PLAY_CAP)).toBe(DEFAULT_PLAY_CAP);
    expect(stepPlay(25, -1, DEFAULT_PLAY_CAP)).toBe(DEFAULT_PLAY_CAP);
  });
});
