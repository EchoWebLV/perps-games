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
  known: Map<string, QueuedTrade>;
  volatile: Map<string, QueuedTrade>;
  removed: Set<string>;
}

interface QueuedTrade {
  queueOrder: number;
  record: TradeRecordInput;
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
  const recordForId = (value: unknown, id: string): TradeRecordInput | null =>
    typeof value === "object" && value !== null && "id" in value && value.id === id
      ? value as TradeRecordInput
      : null;
  const openedAtOrder = (record: TradeRecordInput): number => {
    const openedAt = Date.parse(record.openedAt);
    return Number.isFinite(openedAt) ? openedAt : 0;
  };
  const decodeQueued = (raw: string, id: string): QueuedTrade | null => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof value === "object" && value !== null && "queueOrder" in value && "record" in value) {
      const queueOrder = value.queueOrder;
      const record = recordForId(value.record, id);
      if (typeof queueOrder === "number" && Number.isSafeInteger(queueOrder) && queueOrder >= 0 && record) {
        return { queueOrder, record };
      }
      return null;
    }
    const record = recordForId(value, id);
    return record ? { queueOrder: openedAtOrder(record), record } : null;
  };
  const encodeQueued = (queued: QueuedTrade): string => JSON.stringify(queued);
  const readDurable = (outboxKey: string): Map<string, QueuedTrade> | null => {
    try {
      const records = new Map<string, QueuedTrade>();
      const prefix = recordPrefix(outboxKey);
      const length = store.length;
      for (let index = 0; index < length; index++) {
        const storageKey = store.key(index);
        if (!storageKey?.startsWith(prefix)) continue;
        const id = storageKey.slice(prefix.length);
        const raw = store.getItem(storageKey);
        if (raw === null) continue;
        const queued = decodeQueued(raw, id);
        if (queued) records.set(id, queued);
      }
      return records;
    } catch {
      return null;
    }
  };
  const persistVolatile = (outboxKey: string, state: OutboxState) => {
    for (const [id, queued] of [...state.volatile]) {
      try {
        store.setItem(recordKey(outboxKey, id), encodeQueued(queued));
        state.volatile.delete(id);
      } catch {
        // Retain this record in memory and retry persistence on the next read.
      }
    }
  };
  const readAt = (outboxKey: string): QueuedTrade[] => {
    const state = stateAt(outboxKey);
    persistVolatile(outboxKey, state);
    const durable = readDurable(outboxKey);
    const records = durable === null ? new Map(state.known) : durable;
    for (const [id, queued] of state.volatile) records.set(id, queued);
    for (const id of state.removed) records.delete(id);
    state.known = new Map(records);
    return [...records.values()].sort((left, right) =>
      left.queueOrder - right.queueOrder ||
      left.record.openedAt.localeCompare(right.record.openedAt) ||
      left.record.id.localeCompare(right.record.id));
  };
  const addAt = (outboxKey: string, queued: QueuedTrade) => {
    const state = stateAt(outboxKey);
    const id = queued.record.id;
    state.known.set(id, queued);
    state.removed.delete(id);
    try {
      store.setItem(recordKey(outboxKey, id), encodeQueued(queued));
      state.volatile.delete(id);
    } catch {
      state.volatile.set(id, queued);
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
          await deps.api.recordTrade(item.record, wallet);
        } catch {
          break;
        }
        if (deps.wallet() !== wallet) break;
        removeAt(outboxKey, item.record.id);
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
      if (!items.some((item) => item.record.id === record.id)) {
        const lastOrder = items.reduce((highest, item) => Math.max(highest, item.queueOrder), -1);
        addAt(outboxKey, {
          queueOrder: Math.max(openedAtOrder(record), lastOrder + 1),
          record,
        });
      }
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
