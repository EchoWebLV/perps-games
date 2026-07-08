import { describe, expect, test } from "vitest";
import { validateName } from "./identity";

describe("driver-name validation", () => {
  test("accepts clean handles and normalizes case/whitespace", () => {
    expect(validateName("liq_dodger")).toBe("liq_dodger");
    expect(validateName("  MoonBag_Mia ")).toBe("moonbag_mia");
    expect(validateName("abc")).toBe("abc");
    expect(validateName("a".repeat(16))).toBe("a".repeat(16));
  });

  test("rejects too short, too long, and bad characters", () => {
    expect(validateName("ab")).toBeNull();
    expect(validateName("a".repeat(17))).toBeNull();
    expect(validateName("has space")).toBeNull();
    expect(validateName("emoji🚗")).toBeNull();
    expect(validateName("dash-name")).toBeNull();
    expect(validateName("")).toBeNull();
  });
});
