// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDriverNameDialog } from "./driver-name";

afterEach(() => { document.body.innerHTML = ""; });

function mount(over: Partial<Parameters<typeof createDriverNameDialog>[1]> = {}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const onSave = vi.fn(async () => {});
  const onCancel = vi.fn();
  const dialog = createDriverNameDialog(parent, {
    currentName: "road_king",
    requiredForHighway: false,
    onSave,
    onCancel,
    ...over,
  });
  return { parent, dialog, onSave, onCancel };
}

const field = (root: HTMLElement) => root.querySelector("#driver-name-input") as HTMLInputElement;
const save = (root: HTMLElement) => root.querySelector("#driver-name-save") as HTMLButtonElement;
const cancel = (root: HTMLElement) => root.querySelector("#driver-name-cancel") as HTMLButtonElement;
const message = (root: HTMLElement) => root.querySelector("#driver-name-message") as HTMLElement;

describe("driver name dialog", () => {
  it("prefills the current name and explains a required Highway prompt", () => {
    const { dialog } = mount({ requiredForHighway: true });
    expect(field(dialog.el).value).toBe("road_king");
    expect(dialog.el.textContent).toContain("Choose a name before entering Highway");
  });

  it("rejects an invalid name and stays open", async () => {
    const { dialog, onSave, parent } = mount();
    field(dialog.el).value = "bad name";
    save(dialog.el).click();
    await Promise.resolve();
    expect(message(dialog.el).textContent).toBe("3-16 characters: letters, numbers, underscores");
    expect(onSave).not.toHaveBeenCalled();
    expect(parent.contains(dialog.el)).toBe(true);
  });

  it("normalizes a valid name, saves it, and closes only after success", async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { dialog, parent } = mount({ onSave });
    field(dialog.el).value = "  Liq_Dodger ";
    save(dialog.el).click();

    expect(onSave).toHaveBeenCalledWith("liq_dodger");
    expect(save(dialog.el).disabled).toBe(true);
    expect(parent.contains(dialog.el)).toBe(true);

    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(parent.contains(dialog.el)).toBe(false);
  });

  it("keeps the dialog open and shows an inline error when saving fails", async () => {
    const { dialog, parent } = mount({ onSave: async () => { throw new Error("network"); } });
    save(dialog.el).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(message(dialog.el).textContent).toBe("Couldn't save your driver name. Try again.");
    expect(save(dialog.el).disabled).toBe(false);
    expect(parent.contains(dialog.el)).toBe(true);
  });

  it("cancels without saving and Enter submits", async () => {
    const first = mount();
    cancel(first.dialog.el).click();
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    expect(first.onSave).not.toHaveBeenCalled();

    const second = mount();
    field(second.dialog.el).value = "moon_driver";
    field(second.dialog.el).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(second.onSave).toHaveBeenCalledWith("moon_driver");
  });
});
