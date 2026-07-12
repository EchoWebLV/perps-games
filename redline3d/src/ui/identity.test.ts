/** @vitest-environment jsdom */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createIdentityGate, validateName } from "./identity";

afterEach(() => {
  document.body.replaceChildren();
});

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

test("presents sign-in as the primary action before guest practice", () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });

  const signIn = gate.el.querySelector<HTMLButtonElement>("#idsignin")!;
  const guest = gate.el.querySelector<HTMLButtonElement>("#idguest")!;

  expect(signIn.classList).toContain("cta");
  expect(signIn.classList).toContain("identity-primary");
  expect(guest.classList).not.toContain("cta");
  expect(guest.classList).toContain("identity-secondary");
  expect(signIn.compareDocumentPosition(guest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(gate.el.textContent).toContain("save progress · collect cars · play for real SOL");
  expect(gate.el.textContent).toContain("practice mode · no wallet required");
});

test("keeps sign-in name optional and guest name required", async () => {
  const onGuest = vi.fn();
  const onSignIn = vi.fn().mockResolvedValue(false);
  const gate = createIdentityGate(document.body, { onGuest, onSignIn });

  gate.el.querySelector<HTMLButtonElement>("#idsignin")!.click();
  await Promise.resolve();
  expect(onSignIn).toHaveBeenCalledWith(null);

  gate.el.querySelector<HTMLInputElement>("#idname")!.value = "ab";
  gate.el.querySelector<HTMLButtonElement>("#idguest")!.click();
  expect(onGuest).not.toHaveBeenCalled();

  gate.el.querySelector<HTMLInputElement>("#idname")!.value = "neon_rider";
  gate.el.querySelector<HTMLButtonElement>("#idguest")!.click();
  expect(onGuest).toHaveBeenCalledWith("neon_rider");
});
