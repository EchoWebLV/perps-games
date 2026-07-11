export interface PresenceLifecycleState {
  mode: "race" | "lobby" | "highway" | "garage";
  hasIdentity: boolean;
}

export function presenceShouldConnect(state: PresenceLifecycleState): boolean {
  return (state.mode === "lobby" || state.mode === "highway") && state.hasIdentity;
}

export function presenceHudShouldShow(mode: PresenceLifecycleState["mode"]): boolean {
  return mode === "lobby";
}
