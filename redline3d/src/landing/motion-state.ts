export interface MotionState {
  systemReduced: boolean;
  documentVisible: boolean;
  tutorialVisible: boolean;
  technologyVisible: boolean;
}

export type MotionEvent =
  | { type: "system-reduced"; reduced: boolean }
  | { type: "document-visible" | "tutorial-visible" | "technology-visible"; visible: boolean };

export const initialMotionState = (systemReduced: boolean): MotionState => ({
  systemReduced,
  documentVisible: true,
  tutorialVisible: false,
  technologyVisible: false,
});

export const motionEnabled = (state: MotionState) => !state.systemReduced && state.documentVisible;
export const tutorialPlaybackEnabled = (state: MotionState) => motionEnabled(state) && state.tutorialVisible;
export const technologyMotionEnabled = (state: MotionState) => motionEnabled(state) && state.technologyVisible;

export function reduceMotionState(state: MotionState, event: MotionEvent): MotionState {
  switch (event.type) {
    case "system-reduced": return { ...state, systemReduced: event.reduced };
    case "document-visible": return { ...state, documentVisible: event.visible };
    case "tutorial-visible": return { ...state, tutorialVisible: event.visible };
    case "technology-visible": return { ...state, technologyVisible: event.visible };
  }
}
