export interface MotionState {
  systemReduced: boolean;
  documentVisible: boolean;
  videoSections: ReadonlySet<string>;
  technologyVisible: boolean;
}

export type MotionEvent =
  | { type: "system-reduced"; reduced: boolean }
  | { type: "document-visible" | "technology-visible"; visible: boolean }
  | { type: "video-section"; id: string; visible: boolean };

export const initialMotionState = (systemReduced: boolean): MotionState => ({
  systemReduced,
  documentVisible: true,
  videoSections: new Set<string>(),
  technologyVisible: false,
});

export const motionEnabled = (state: MotionState) => !state.systemReduced && state.documentVisible;
export const videoPlaybackEnabled = (state: MotionState, sectionId: string) =>
  motionEnabled(state) && state.videoSections.has(sectionId);
export const technologyMotionEnabled = (state: MotionState) => motionEnabled(state) && state.technologyVisible;

export function reduceMotionState(state: MotionState, event: MotionEvent): MotionState {
  switch (event.type) {
    case "system-reduced": return { ...state, systemReduced: event.reduced };
    case "document-visible": return { ...state, documentVisible: event.visible };
    case "technology-visible": return { ...state, technologyVisible: event.visible };
    case "video-section": {
      const videoSections = new Set(state.videoSections);
      if (event.visible) videoSections.add(event.id);
      else videoSections.delete(event.id);
      return { ...state, videoSections };
    }
  }
}
