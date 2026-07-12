// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAccessWall } from "./access-wall";
import type { RedeemResult } from "../core/access-code";

// Reset the document between tests. The wall's controls are looked up by id (#awcode / #awgo / …);
// jsdom resolves even a node-scoped `#id` query through the document-wide id map, so a leftover wall
// from a prior test would shadow the fresh one's ids and null them out. (Production only ever mounts
// one wall, so this is purely test hygiene.)
afterEach(() => { document.body.innerHTML = ""; });

// Mount a wall whose redeem returns a fixed outcome (or a per-code function), spying on both ports.
function mount(outcome: RedeemResult | ((code: string) => RedeemResult)) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const onRedeem = vi.fn((code: string) => (typeof outcome === "function" ? outcome(code) : outcome));
  const onUnlocked = vi.fn();
  const wall = createAccessWall(parent, { onRedeem, onUnlocked });
  return { parent, wall, onRedeem, onUnlocked };
}

const codeField = (root: HTMLElement) => root.querySelector("#awcode") as HTMLInputElement;
const unlockBtn = (root: HTMLElement) => root.querySelector("#awgo") as HTMLButtonElement;
const message = (root: HTMLElement) => root.querySelector("#awmsg") as HTMLElement;

describe("access wall — only a code field, nothing else", () => {
  test("shows the title, one code field and UNLOCK — never guest / sign-in / name", () => {
    const { wall } = mount("invalid");
    expect(wall.el.textContent).toContain("PERPS RIDER");
    expect(codeField(wall.el)).toBeTruthy();
    expect(unlockBtn(wall.el).textContent).toContain("UNLOCK");
    // none of the identity gate's doors may leak onto the wall
    expect(wall.el.querySelector("#idname")).toBeNull();
    expect(wall.el.querySelector("#idguest")).toBeNull();
    expect(wall.el.querySelector("#idsignin")).toBeNull();
    const text = wall.el.textContent!.toLowerCase();
    expect(text).not.toContain("guest");
    expect(text).not.toContain("sign in");
  });

  test("is a full-screen overlay that captures pointer input (blocks the canvas joystick)", () => {
    const { wall } = mount("invalid");
    expect(wall.el.style.position).toBe("fixed");
    expect(wall.el.style.pointerEvents).toBe("auto");
    expect(wall.el.style.zIndex).toBe("40"); // above the identity gate (30)
  });
});

describe("access wall — redeeming a code", () => {
  test("a valid code redeems, lands the player in-world once, and tears the wall down", () => {
    const { wall, onRedeem, onUnlocked, parent } = mount("granted");
    codeField(wall.el).value = "magic";
    unlockBtn(wall.el).click();
    expect(onRedeem).toHaveBeenCalledWith("magic");
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(parent.contains(wall.el)).toBe(false); // wall removed from the DOM
  });

  test("an already-redeemed code unlocks too (treated like granted)", () => {
    const { wall, onUnlocked, parent } = mount("already");
    codeField(wall.el).value = "magic";
    unlockBtn(wall.el).click();
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(parent.contains(wall.el)).toBe(false);
  });

  test("a wrong code shows 'invalid code' inline and stays walled", () => {
    const { wall, onUnlocked, parent } = mount("invalid");
    codeField(wall.el).value = "nope";
    unlockBtn(wall.el).click();
    expect(message(wall.el).textContent).toBe("invalid code");
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(parent.contains(wall.el)).toBe(true); // still up
  });

  test("an empty / whitespace submit does nothing — no redeem, still walled", () => {
    const { wall, onRedeem, onUnlocked, parent } = mount("granted");
    codeField(wall.el).value = "   ";
    unlockBtn(wall.el).click();
    expect(onRedeem).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(parent.contains(wall.el)).toBe(true);
  });

  test("Enter in the code field submits", () => {
    const { wall, onUnlocked } = mount("granted");
    const inp = codeField(wall.el);
    inp.value = "magic";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  test("editing after a rejected code clears the inline message", () => {
    const { wall } = mount("invalid");
    const inp = codeField(wall.el);
    inp.value = "nope";
    unlockBtn(wall.el).click();
    expect(message(wall.el).textContent).toBe("invalid code");
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })); // any edit key
    expect(message(wall.el).textContent).toBe("");
  });
});

describe("access wall — keyboard is trapped so the game can't drive behind it", () => {
  test("the code field stops its key events from reaching the game's window handlers", () => {
    const { wall } = mount("invalid");
    const ev = new KeyboardEvent("keydown", { key: "w", bubbles: true, cancelable: true });
    const stop = vi.spyOn(ev, "stopPropagation");
    codeField(wall.el).dispatchEvent(ev);
    expect(stop).toHaveBeenCalled();
  });
});
