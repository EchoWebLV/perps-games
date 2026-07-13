import { describe, expect, it } from "vitest";

const motionModules = import.meta.glob("./motion-state.ts");

async function loadMotionState() {
  expect(Object.keys(motionModules)).toHaveLength(1);
  return Object.values(motionModules)[0]() as Promise<any>;
}

describe("landing motion state", () => {
  it("derives its initial state only from the system motion preference", async () => {
    const { initialMotionState, motionEnabled } = await loadMotionState();
    const state = initialMotionState(true);

    expect(state).toEqual({
      systemReduced: true,
      documentVisible: true,
      tutorialVisible: false,
      technologyVisible: false,
    });
    expect(motionEnabled(state)).toBe(false);
  });

  it("runs tutorial and technology motion only while visible", async () => {
    const { initialMotionState, reduceMotionState, technologyMotionEnabled, tutorialPlaybackEnabled } = await loadMotionState();
    let state = initialMotionState(false);
    expect(tutorialPlaybackEnabled(state)).toBe(false);
    expect(technologyMotionEnabled(state)).toBe(false);
    state = reduceMotionState(state, { type: "tutorial-visible", visible: true });
    state = reduceMotionState(state, { type: "technology-visible", visible: true });
    expect(tutorialPlaybackEnabled(state)).toBe(true);
    expect(technologyMotionEnabled(state)).toBe(true);
  });

  it("stops everything while the document is hidden", async () => {
    const { initialMotionState, motionEnabled, reduceMotionState } = await loadMotionState();
    let state = initialMotionState(false);
    state = reduceMotionState(state, { type: "document-visible", visible: false });
    expect(motionEnabled(state)).toBe(false);
    state = reduceMotionState(state, { type: "document-visible", visible: true });
    expect(motionEnabled(state)).toBe(true);
  });

  it("reacts when the system preference changes", async () => {
    const { initialMotionState, motionEnabled, reduceMotionState } = await loadMotionState();
    const state = reduceMotionState(initialMotionState(false), { type: "system-reduced", reduced: true });
    expect(state.systemReduced).toBe(true);
    expect(motionEnabled(state)).toBe(false);
  });
});
