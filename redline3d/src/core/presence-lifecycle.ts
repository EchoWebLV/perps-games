export interface PresenceLifecycleState {
  // home/grandprix carry no presence (neither connects nor shows the HUD) — the predicates below
  // only ever light up for lobby/highway, so widening the union keeps them correctly dark.
  mode: "race" | "lobby" | "highway" | "garage" | "home" | "grandprix";
  hasIdentity: boolean;
}

export function presenceShouldConnect(state: PresenceLifecycleState): boolean {
  return (state.mode === "lobby" || state.mode === "highway") && state.hasIdentity;
}

export function presenceHudShouldShow(mode: PresenceLifecycleState["mode"]): boolean {
  return mode === "lobby";
}
