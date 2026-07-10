import type { Api, TradeRecordInput } from "./api";

export type ActiveTradeDraft = Omit<TradeRecordInput, "id" | "exitPrice" | "outcome" | "payoutBase">;
export type TradeCompletion = Pick<TradeRecordInput, "exitPrice" | "outcome" | "payoutBase">;

export interface TradeHistoryRecorder {
  begin(draft: ActiveTradeDraft): void;
  complete(result: TradeCompletion): TradeRecordInput | null;
  flush(): Promise<void>;
  pending(): number;
}

const PREFIX = "redline.trade-history.outbox.v1:";

interface OutboxState {
  items: TradeRecordInput[];
  loaded: boolean;
}

const sessionOutboxes = new WeakMap<Storage, Map<string, OutboxState>>();

function outboxesFor(store: Storage): Map<string, OutboxState> {
  let outboxes = sessionOutboxes.get(store);
  if (!outboxes) {
    outboxes = new Map();
    sessionOutboxes.set(store, outboxes);
  }
  return outboxes;
}

export function createTradeHistoryRecorder(deps: {
  api: Pick<Api, "recordTrade">;
  wallet: () => string;
  store?: Storage;
  newId?: () => string;
}): TradeHistoryRecorder {
  const store = deps.store ?? localStorage;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const outboxes = outboxesFor(store);
  let active: (ActiveTradeDraft & { id: string; outboxKey: string }) | null = null;
  const flushing = new Map<string, Promise<void>>();
  const key = (wallet: string) => PREFIX + wallet;
  const stateAt = (outboxKey: string): OutboxState => {
    let state = outboxes.get(outboxKey);
    if (!state) {
      state = { items: [], loaded: false };
      outboxes.set(outboxKey, state);
    }
    return state;
  };
  const readAt = (outboxKey: string): TradeRecordInput[] => {
    const state = stateAt(outboxKey);
    if (!state.loaded) {
      try {
        const value = JSON.parse(store.getItem(outboxKey) ?? "[]");
        state.items = Array.isArray(value) ? value : [];
        state.loaded = true;
      } catch {
        // Keep the in-memory copy and retry storage only until a successful read or local write.
      }
    }
    return [...state.items];
  };
  const writeAt = (outboxKey: string, items: TradeRecordInput[]) => {
    const state = stateAt(outboxKey);
    state.items = [...items];
    state.loaded = true;
    try {
      if (items.length) store.setItem(outboxKey, JSON.stringify(items));
      else store.removeItem(outboxKey);
    } catch {
      // The same-session queue remains authoritative until durable storage works again.
    }
  };

  return {
    begin(draft) {
      const wallet = deps.wallet();
      if (wallet) active = { ...draft, id: newId(), outboxKey: key(wallet) };
    },
    complete(result) {
      if (!active) return null;
      const { outboxKey, ...draft } = active;
      const record = { ...draft, ...result };
      active = null;
      const items = readAt(outboxKey);
      if (!items.some((item) => item.id === record.id)) writeAt(outboxKey, [...items, record]);
      return record;
    },
    flush() {
      const wallet = deps.wallet();
      if (!wallet) return Promise.resolve();
      const outboxKey = key(wallet);
      const current = flushing.get(outboxKey);
      if (current) return current;
      const task = (async () => {
        while (deps.wallet() === wallet) {
          const item = readAt(outboxKey)[0];
          if (!item) break;
          try {
            await deps.api.recordTrade(item, wallet);
          } catch {
            break;
          }
          if (deps.wallet() !== wallet) break;
          writeAt(outboxKey, readAt(outboxKey).filter((pending) => pending.id !== item.id));
        }
      })().finally(() => {
        if (flushing.get(outboxKey) === task) flushing.delete(outboxKey);
      });
      flushing.set(outboxKey, task);
      return task;
    },
    pending() {
      const wallet = deps.wallet();
      return wallet ? readAt(key(wallet)).length : 0;
    },
  };
}
