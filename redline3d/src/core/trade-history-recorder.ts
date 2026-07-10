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
  known: Map<string, TradeRecordInput>;
  volatile: Map<string, TradeRecordInput>;
  removed: Set<string>;
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
  const recordPrefix = (outboxKey: string) => `${outboxKey}:`;
  const recordKey = (outboxKey: string, id: string) => recordPrefix(outboxKey) + id;
  const stateAt = (outboxKey: string): OutboxState => {
    let state = outboxes.get(outboxKey);
    if (!state) {
      state = { known: new Map(), volatile: new Map(), removed: new Set() };
      outboxes.set(outboxKey, state);
    }
    return state;
  };
  const readDurable = (outboxKey: string): Map<string, TradeRecordInput> | null => {
    try {
      const records = new Map<string, TradeRecordInput>();
      const prefix = recordPrefix(outboxKey);
      const length = store.length;
      for (let index = 0; index < length; index++) {
        const storageKey = store.key(index);
        if (!storageKey?.startsWith(prefix)) continue;
        const id = storageKey.slice(prefix.length);
        const value: unknown = JSON.parse(store.getItem(storageKey) ?? "null");
        if (typeof value === "object" && value !== null && "id" in value && value.id === id) {
          records.set(id, value as TradeRecordInput);
        }
      }
      return records;
    } catch {
      return null;
    }
  };
  const readAt = (outboxKey: string): TradeRecordInput[] => {
    const state = stateAt(outboxKey);
    const durable = readDurable(outboxKey);
    const records = durable === null ? new Map(state.known) : durable;
    for (const [id, record] of state.volatile) records.set(id, record);
    for (const id of state.removed) records.delete(id);
    state.known = new Map(records);
    return [...records.values()];
  };
  const addAt = (outboxKey: string, record: TradeRecordInput) => {
    const state = stateAt(outboxKey);
    state.known.set(record.id, record);
    state.removed.delete(record.id);
    try {
      store.setItem(recordKey(outboxKey, record.id), JSON.stringify(record));
      state.volatile.delete(record.id);
    } catch {
      state.volatile.set(record.id, record);
    }
  };
  const removeAt = (outboxKey: string, id: string) => {
    const state = stateAt(outboxKey);
    state.known.delete(id);
    state.volatile.delete(id);
    state.removed.add(id);
    try {
      store.removeItem(recordKey(outboxKey, id));
      state.removed.delete(id);
    } catch {
      // The tombstone prevents a failed durable removal from replaying in this session.
    }
  };
  const flushAt = (wallet: string, outboxKey: string): Promise<void> => {
    const current = flushing.get(outboxKey);
    if (current) return current;
    let endedEmpty = false;
    const drain = async () => {
      while (deps.wallet() === wallet) {
        const item = readAt(outboxKey)[0];
        if (!item) {
          endedEmpty = true;
          break;
        }
        try {
          await deps.api.recordTrade(item, wallet);
        } catch {
          break;
        }
        if (deps.wallet() !== wallet) break;
        removeAt(outboxKey, item.id);
      }
    };
    let task!: Promise<void>;
    task = drain().finally(() => {
      if (flushing.get(outboxKey) !== task) return;
      flushing.delete(outboxKey);
      if (endedEmpty && deps.wallet() === wallet && readAt(outboxKey).length) {
        return flushAt(wallet, outboxKey);
      }
    });
    flushing.set(outboxKey, task);
    return task;
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
      if (!items.some((item) => item.id === record.id)) addAt(outboxKey, record);
      return record;
    },
    flush() {
      const wallet = deps.wallet();
      if (!wallet) return Promise.resolve();
      const outboxKey = key(wallet);
      return flushAt(wallet, outboxKey);
    },
    pending() {
      const wallet = deps.wallet();
      return wallet ? readAt(key(wallet)).length : 0;
    },
  };
}
