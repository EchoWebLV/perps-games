import { describe, expect, test } from "vitest";
import { COIN_VOLUME } from "./audio";

describe("audio constants", () => {
  test("keeps coin pickups below the main audio bed", () => {
    expect(COIN_VOLUME).toBe(0.25);
  });
});
