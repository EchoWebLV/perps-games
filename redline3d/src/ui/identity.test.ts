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

test("keeps the centered card scrollable within short safe-area viewports", () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });

  const card = gate.el.querySelector<HTMLElement>(".panel")!;

  expect(card.style.maxHeight).toContain("100dvh");
  expect(card.style.maxHeight).toContain("safe-area-inset-top");
  expect(card.style.maxHeight).toContain("safe-area-inset-bottom");
  expect(card.style.overflowY).toBe("auto");
});

test("associates the driver-name label and live status with the input", () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });

  const input = gate.el.querySelector<HTMLInputElement>("#idname")!;
  const label = gate.el.querySelector<HTMLLabelElement>('label[for="idname"]');
  const message = gate.el.querySelector<HTMLElement>("#idmsg")!;

  expect(label).not.toBeNull();
  expect(label!.textContent).toBe("driver name · optional for sign in");
  expect(input.getAttribute("aria-describedby")).toBe("idmsg");
  expect(message.getAttribute("role")).toBe("status");
  expect(message.getAttribute("aria-live")).toBe("polite");
});

test("lets the scoped keyboard-focus outline render on the name input", () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });

  const input = gate.el.querySelector<HTMLInputElement>("#idname")!;
  const scopedStyles = gate.el.querySelector<HTMLStyleElement>("style")!.textContent;

  expect(input.style.outline).toBe("");
  expect(scopedStyles).toMatch(/#idname:focus-visible\s*\{/);
});

test("paints the clipped sign-in focus ring inside the primary CTA", () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });

  const scopedStyles = gate.el.querySelector<HTMLStyleElement>("style")!.textContent;
  const signInRule = scopedStyles.match(/#idsignin\.identity-primary:focus-visible\s*\{([^}]*)\}/)?.[1];

  expect(signInRule).toBeDefined();
  expect(signInRule ?? "").toContain("outline:none");
  expect(signInRule ?? "").toMatch(/box-shadow:[^;]*inset[^;]*var\(--cyan\)/);
  expect(scopedStyles).toMatch(
    /#idguest\.identity-secondary:focus-visible,\s*#idname:focus-visible\s*\{[^}]*outline:2px solid var\(--cyan\)/,
  );
});

test("clears stale validation when the name becomes valid or empty", () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });
  const input = gate.el.querySelector<HTMLInputElement>("#idname")!;
  const guest = gate.el.querySelector<HTMLButtonElement>("#idguest")!;
  const message = gate.el.querySelector<HTMLElement>("#idmsg")!;

  input.value = "ab";
  guest.click();
  expect(message.textContent).toBe("3-16 characters: letters, numbers, underscores");

  input.value = "neon_rider";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(message.textContent).toBe("");

  input.value = "ab";
  guest.click();
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(message.textContent).toBe("");
});

test("clears stale validation while a corrected sign-in is pending", async () => {
  let finishSignIn!: (result: boolean) => void;
  const onSignIn = vi.fn(() => new Promise<boolean>((resolve) => { finishSignIn = resolve; }));
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn,
  });
  const input = gate.el.querySelector<HTMLInputElement>("#idname")!;
  const signIn = gate.el.querySelector<HTMLButtonElement>("#idsignin")!;
  const message = gate.el.querySelector<HTMLElement>("#idmsg")!;

  input.value = "ab";
  signIn.click();
  expect(message.textContent).toBe("3-16 characters: letters, numbers, underscores");

  input.value = "neon_rider";
  signIn.click();
  expect(onSignIn).toHaveBeenCalledWith("neon_rider");
  expect(message.textContent).toBe("");

  finishSignIn(false);
  await vi.waitFor(() => {
    expect(message.textContent).toBe("Sign-in didn't finish — try again, or ride as guest.");
  });
});

test("gives the guest action a 44px minimum touch target", () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });

  const guest = gate.el.querySelector<HTMLButtonElement>("#idguest")!;

  expect(getComputedStyle(guest).minHeight).toBe("44px");
});

test("preserves the sign-in label span after a failed attempt", async () => {
  const gate = createIdentityGate(document.body, {
    onGuest: vi.fn(),
    onSignIn: vi.fn().mockResolvedValue(false),
  });

  gate.el.querySelector<HTMLButtonElement>("#idsignin")!.click();
  await vi.waitFor(() => {
    const label = gate.el.querySelector<HTMLElement>("#idsigninlabel");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("SIGN IN");
  });
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
