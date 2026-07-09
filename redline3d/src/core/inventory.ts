// Persistent ownership store — the source of truth for what the player has unlocked. Cars are a
// COUNTED collection (duplicates stack, and spare copies are melted at the Scrap Yard); level/world
// skins use the same store but only ever need own/not-own. Generic over a storage `key`.

export interface Inventory {
  owns(id: string): boolean;
  /** how many copies are owned (0 if never pulled) */
  count(id: string): number;
  /** grant a copy; returns true only on the 0->1 transition (a NEW unlock), false for a duplicate */
  grant(id: string): boolean;
  /** spare copies above the kept floor of 1 (0 if unowned or the only copy) */
  spares(id: string): number;
  /** shed one spare copy; no-op returning false if there is no spare (the last copy is never lost) */
  melt(id: string): boolean;
  all(): string[];
  /** cars that have at least one spare, with their total count */
  meltable(): { id: string; count: number }[];
  /** current counts as a plain object — the first-bind migration snapshot */
  snapshot(): Record<string, number>;
  /** replace all counts from a server snapshot; the free floor is re-applied. No hooks fired. */
  hydrate(counts: Record<string, number>): void;
}

/** `free` ids are always owned at count >= 1 (Solana Paper / default level). `storage` is injectable for tests. */
export function createInventory(
  key: string,
  free: string[] = [],
  storage: Storage = localStorage,
  hooks: { onGrant?: (id: string, isNew: boolean) => void; onMelt?: (id: string, melted: boolean) => void } = {},
): Inventory {
  const counts = new Map<string, number>();
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // legacy format: a JSON array of owned ids -> one copy each (migration)
        for (const id of parsed as string[]) counts.set(id, Math.max(counts.get(id) ?? 0, 1));
      } else if (parsed && typeof parsed === "object") {
        for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) {
          const c = Math.max(0, Math.floor(Number(n) || 0));
          if (c > 0) counts.set(id, c);
        }
      }
    }
  } catch { /* private mode / bad json -> free items only */ }
  // free items are always present at >= 1
  for (const id of free) if ((counts.get(id) ?? 0) < 1) counts.set(id, 1);

  const persist = () => { try { storage.setItem(key, JSON.stringify(Object.fromEntries(counts))); } catch { /* ignore */ } };
  persist(); // stabilize free items across reloads even before the first grant

  return {
    owns: (id) => (counts.get(id) ?? 0) > 0,
    count: (id) => counts.get(id) ?? 0,
    grant: (id) => {
      const prev = counts.get(id) ?? 0;
      counts.set(id, prev + 1);
      persist();
      const isNew = prev === 0;
      hooks.onGrant?.(id, isNew);
      return isNew;
    },
    spares: (id) => Math.max(0, (counts.get(id) ?? 0) - 1),
    melt: (id) => {
      const prev = counts.get(id) ?? 0;
      if (prev <= 1) { hooks.onMelt?.(id, false); return false; } // keep the last copy — melting only sheds spares
      counts.set(id, prev - 1);
      persist();
      hooks.onMelt?.(id, true);
      return true;
    },
    all: () => [...counts.entries()].filter(([, n]) => n > 0).map(([id]) => id),
    meltable: () => [...counts.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n })),
    snapshot: () => Object.fromEntries([...counts.entries()].filter(([, n]) => n > 0)),
    hydrate: (next) => {
      counts.clear();
      for (const [id, n] of Object.entries(next)) {
        const c = Math.max(0, Math.floor(Number(n) || 0));
        if (c > 0) counts.set(id, c);
      }
      for (const id of free) if ((counts.get(id) ?? 0) < 1) counts.set(id, 1); // free floor survives
      persist();
    },
  };
}
