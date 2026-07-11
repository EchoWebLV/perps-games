import type { PresenceEmote, PresenceEmoteKind } from "./presence";

export interface PresenceEmoteHandlers {
  local(kind: PresenceEmoteKind): void;
  remote(event: PresenceEmote): void;
}

export function routePresenceEmote(
  event: PresenceEmote,
  localId: string | null,
  handlers: PresenceEmoteHandlers,
): void {
  try {
    if (localId !== null && event.id === localId) handlers.local(event.kind);
    else handlers.remote(event);
  } catch {
    // Presence visuals are optional. A renderer failure must not interrupt local driving.
  }
}
