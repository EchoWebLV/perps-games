import { describe, expect, it } from "vitest";
import { stepPlay, DEFAULT_PLAY_CAP, isTextEntry, driveKeyOf } from "./controls";

// Duck-typed element stand-ins (no jsdom): isTextEntry only reads tagName / isContentEditable /
// getAttribute("type"). Cast through unknown so we don't need a full HTMLElement.
const el = (tagName: string, opts: { type?: string | null; editable?: boolean } = {}) =>
  ({ tagName, isContentEditable: opts.editable ?? false, getAttribute: () => opts.type ?? null } as unknown as HTMLElement);

describe("isTextEntry (only real text entry suppresses WASD driving)", () => {
  it("suppresses driving for genuine text fields", () => {
    expect(isTextEntry(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTextEntry(el("INPUT", { type: null }))).toBe(true); // default type is text
    expect(isTextEntry(el("INPUT", { type: "email" }))).toBe(true); // the Privy login field
    expect(isTextEntry(el("TEXTAREA"))).toBe(true);
    expect(isTextEntry(el("DIV", { editable: true }))).toBe(true);
  });

  it("KEEPS driving for non-text focus — the states that were silently killing WASD", () => {
    expect(isTextEntry(el("INPUT", { type: "range" }))).toBe(false); // Pink Rod auto-exit slider
    expect(isTextEntry(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTextEntry(el("BUTTON"))).toBe(false); // a focused GO / CASH OUT button
    expect(isTextEntry(el("DIV"))).toBe(false); // a wallet modal's leftover overlay div
    expect(isTextEntry(null)).toBe(false); // body / nothing focused
  });
});

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

describe("driveKeyOf (layout-independent driving keys — prod WASD-dead-on-Cyrillic fix)", () => {
  const ev = (key: string, code = "", mods: Partial<KeyboardEvent> = {}) =>
    ({ key, code, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent);

  it("matches by PHYSICAL key (e.code) so any keyboard layout drives", () => {
    // Bulgarian phonetic: physical W types "в" — e.key never equals "w"
    expect(driveKeyOf(ev("в", "KeyW"))).toBe("gas");
    expect(driveKeyOf(ev("ф", "KeyA"))).toBe("left");
    expect(driveKeyOf(ev("с", "KeyS"))).toBe("brake");
    expect(driveKeyOf(ev("д", "KeyD"))).toBe("right");
  });

  it("keeps the US-layout and arrow matches (regression)", () => {
    expect(driveKeyOf(ev("w", "KeyW"))).toBe("gas");
    expect(driveKeyOf(ev("W", "KeyW"))).toBe("gas");
    expect(driveKeyOf(ev("ArrowUp", "ArrowUp"))).toBe("gas");
    expect(driveKeyOf(ev("ArrowDown", "ArrowDown"))).toBe("brake");
    expect(driveKeyOf(ev("ArrowLeft", "ArrowLeft"))).toBe("left");
    expect(driveKeyOf(ev("ArrowRight", "ArrowRight"))).toBe("right");
    expect(driveKeyOf(ev(" ", "Space"))).toBe("go");
    expect(driveKeyOf(ev("Enter", "Enter"))).toBe("go");
  });

  it("synthetic events with no code still match by key (test harnesses, virtual keyboards)", () => {
    expect(driveKeyOf(ev("w"))).toBe("gas");
    expect(driveKeyOf(ev("a"))).toBe("left");
  });

  it("never hijacks browser shortcuts (cmd/ctrl/alt + key)", () => {
    expect(driveKeyOf(ev("w", "KeyW", { metaKey: true }))).toBe(null);   // cmd+W = close tab
    expect(driveKeyOf(ev("w", "KeyW", { ctrlKey: true }))).toBe(null);
    expect(driveKeyOf(ev("a", "KeyA", { altKey: true }))).toBe(null);
  });

  it("ignores non-driving keys", () => {
    expect(driveKeyOf(ev("q", "KeyQ"))).toBe(null);
    expect(driveKeyOf(ev("Escape", "Escape"))).toBe(null);
  });
});
