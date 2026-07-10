// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { stepPlay, DEFAULT_PLAY_CAP, isTextEntry, driveKeyOf, keyAction, isNativeActivateTarget, createControls } from "./controls";

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

describe("isNativeActivateTarget (elements whose native Space/Enter must not be hijacked by GO)", () => {
  const el = (tagName: string, opts: { type?: string | null; role?: string | null; editable?: boolean } = {}) =>
    ({ tagName, isContentEditable: opts.editable ?? false,
       getAttribute: (a: string) => (a === "role" ? (opts.role ?? null) : (opts.type ?? null)) } as unknown as HTMLElement);

  it("treats real interactive controls as native-activate targets", () => {
    expect(isNativeActivateTarget(el("BUTTON"))).toBe(true);        // a focused menu / GO / wallet button
    expect(isNativeActivateTarget(el("A"))).toBe(true);
    expect(isNativeActivateTarget(el("SELECT"))).toBe(true);
    expect(isNativeActivateTarget(el("INPUT", { type: "checkbox" }))).toBe(true); // Space toggles it
    expect(isNativeActivateTarget(el("INPUT", { type: "text" }))).toBe(true);     // text entry too
    expect(isNativeActivateTarget(el("DIV", { role: "button" }))).toBe(true);     // ARIA button
  });

  it("does NOT treat the game surface / plain elements as native-activate targets", () => {
    expect(isNativeActivateTarget(el("CANVAS"))).toBe(false); // the driving surface — Space should GO
    expect(isNativeActivateTarget(el("DIV"))).toBe(false);
    expect(isNativeActivateTarget(null)).toBe(false);         // body / nothing focused
  });
});

describe("keyAction (should a keydown drive, launch GO, or be left alone)", () => {
  it("launches GO from Space/Enter only on the track with no panel and no focused control", () => {
    expect(keyAction("go", { typing: false, panelOpen: false, onControl: false })).toBe("go");
  });

  it("never synthesizes a hidden GO behind an open panel/menu (upgrades.isOpen etc.)", () => {
    expect(keyAction("go", { typing: false, panelOpen: true, onControl: false })).toBe("ignore");
  });

  it("defers GO to native activation when focus is on a real button (no swallowed click)", () => {
    expect(keyAction("go", { typing: false, panelOpen: false, onControl: true })).toBe("ignore");
  });

  it("never launches GO while typing in a text field", () => {
    expect(keyAction("go", { typing: true, panelOpen: false, onControl: false })).toBe("ignore");
  });

  it("keeps WASD/arrow driving even with a panel open or a non-text control focused", () => {
    expect(keyAction("gas", { typing: false, panelOpen: true, onControl: true })).toBe("drive");
    expect(keyAction("left", { typing: false, panelOpen: true, onControl: false })).toBe("drive");
    expect(keyAction("brake", { typing: false, panelOpen: false, onControl: true })).toBe("drive");
  });

  it("only genuine text entry suppresses driving (a focused slider/button must not kill WASD)", () => {
    expect(keyAction("gas", { typing: true, panelOpen: false, onControl: false })).toBe("ignore");
  });

  it("ignores a non-mapped key", () => {
    expect(keyAction(null, { typing: false, panelOpen: false, onControl: false })).toBe("ignore");
  });
});

describe("createControls setBusy (launch/bail state on the GO button)", () => {
  const mk = () => {
    const ctrl = document.createElement("div");
    const goMount = document.createElement("div");
    const pedal = document.createElement("div");
    const controls = createControls(ctrl, goMount, pedal);
    const go = goMount.querySelector("#go") as HTMLButtonElement;
    const golabel = goMount.querySelector("#golabel") as HTMLElement;
    return { controls, go, golabel };
  };

  it("shows the busy label, marks the button busy, and drops the gauge look", () => {
    const { controls, go, golabel } = mk();
    controls.setBusy("LAUNCHING…");
    expect(golabel.textContent).toBe("LAUNCHING…");
    expect(go.classList.contains("busy")).toBe(true);
    expect(go.getAttribute("aria-busy")).toBe("true");
  });

  it("blocks the launch callback while busy, then re-enables it (and the label) when cleared", () => {
    const { controls, go, golabel } = mk();
    let launches = 0;
    controls.onLaunch(() => { launches++; });
    controls.setBusy("LAUNCHING…");
    go.click();
    expect(launches).toBe(0); // busy swallows the tap — and the keyboard GO, which routes through go.click()
    controls.setBusy(null);
    expect(go.classList.contains("busy")).toBe(false);
    expect(go.hasAttribute("aria-busy")).toBe(false);
    expect(golabel.textContent).toBe("GO!"); // restored to the idle label
    go.click();
    expect(launches).toBe(1);
  });

  it("restores the live BAIL rendering when a bail overlay clears", () => {
    const { controls, go, golabel } = mk();
    controls.setLive(true, "CASH OUT");
    controls.setBusy("BAILING…");
    expect(golabel.textContent).toBe("BAILING…");
    expect(go.classList.contains("gauge")).toBe(false); // busy hides the gauge look
    controls.setBusy(null);
    expect(golabel.textContent).toBe("CASH OUT"); // back to the live label
    expect(go.classList.contains("gauge")).toBe(true); // and the gauge look
  });

  it("busy overrides a per-frame setLive until it is cleared", () => {
    const { controls, golabel } = mk();
    controls.setBusy("LAUNCHING…");
    controls.setLive(true, "CASH OUT $0.10"); // the render loop keeps painting the live payout label
    expect(golabel.textContent).toBe("LAUNCHING…"); // busy still wins
    controls.setBusy(null);
    expect(golabel.textContent).toBe("CASH OUT $0.10");
  });
});
