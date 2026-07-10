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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE_ORDER_PATTERN = /^\d{16}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{16}$/i;
const UTC_DATETIME_PATTERN = /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?Z$/;
const ORDER_PART_WIDTH = 16;

interface RealmOrderState {
  counter: number;
  lastEpoch: number;
}

const realmOrderStates = new Map<string, RealmOrderState>();
let generatedRealmId: string | null = null;

function cryptoUuid(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("trade_history_secure_uuid_unavailable");
  }
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function moduleRealmId(): string {
  generatedRealmId ??= cryptoUuid();
  return generatedRealmId;
}

function orderPart(value: number): string {
  return String(Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))).padStart(ORDER_PART_WIDTH, "0");
}

function queueOrderEpoch(queueOrder: string): number | null {
  if (!QUEUE_ORDER_PATTERN.test(queueOrder)) return null;
  const epoch = Number(queueOrder.slice(0, ORDER_PART_WIDTH));
  const counter = Number(queueOrder.slice(-ORDER_PART_WIDTH));
  return Number.isSafeInteger(epoch) &&
    epoch < Number.MAX_SAFE_INTEGER &&
    Number.isSafeInteger(counter)
    ? epoch
    : null;
}

function nextQueueOrder(realmId: string, now: () => number, maxPendingEpoch: number): string {
  const state = realmOrderStates.get(realmId) ?? { counter: 0, lastEpoch: 0 };
  const observedEpoch = now();
  const safeEpoch = Number.isFinite(observedEpoch) && observedEpoch >= 0 ? observedEpoch : Date.now();
  const enqueueEpoch = Math.max(state.lastEpoch, Math.floor(safeEpoch), maxPendingEpoch + 1);
  if (enqueueEpoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error("trade_history_queue_order_exhausted");
  }
  const queueOrder = `${orderPart(enqueueEpoch)}:${realmId}:${orderPart(state.counter)}`;
  realmOrderStates.set(realmId, {
    lastEpoch: enqueueEpoch,
    counter: state.counter + 1,
  });
  return queueOrder;
}

function legacyQueueOrder(value: number, recordId: string): string {
  return `${orderPart(value)}:${recordId.toLowerCase()}:${orderPart(0)}`;
}

function recordForId(value: unknown, id: string): TradeRecordInput | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.id !== id || !UUID_PATTERN.test(id)) return null;
  if (record.asset !== "BTC" && record.asset !== "ETH" && record.asset !== "SOL") return null;
  if (record.dir !== 1 && record.dir !== -1) return null;
  if (typeof record.lev !== "number" || !Number.isInteger(record.lev) || record.lev < 1 || record.lev > 3000) return null;
  if (typeof record.stakeBase !== "number" || !Number.isSafeInteger(record.stakeBase) || record.stakeBase <= 0) return null;
  if (typeof record.entryPrice !== "number" || !Number.isFinite(record.entryPrice) || record.entryPrice <= 0) return null;
  if (typeof record.exitPrice !== "number" || !Number.isFinite(record.exitPrice) || record.exitPrice <= 0) return null;
  if (typeof record.openedAt !== "string" || !UTC_DATETIME_PATTERN.test(record.openedAt)) return null;
  if (record.outcome !== "cashout" && record.outcome !== "cap" && record.outcome !== "liq" && record.outcome !== "time") return null;
  if (typeof record.payoutBase !== "number" || !Number.isSafeInteger(record.payoutBase) || record.payoutBase < 0) return null;
  return {
    id,
    asset: record.asset,
    dir: record.dir,
    lev: record.lev,
    stakeBase: record.stakeBase,
    entryPrice: record.entryPrice,
    exitPrice: record.exitPrice,
    openedAt: record.openedAt,
    outcome: record.outcome,
    payoutBase: record.payoutBase,
  };
}

interface OutboxState {
  known: Map<string, QueuedTrade>;
  volatile: Map<string, QueuedTrade>;
  removed: Set<string>;
}

interface QueuedTrade {
  queueOrder: string;
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
  now?: () => number;
  realmId?: string;
}): TradeHistoryRecorder {
  const store = deps.store ?? localStorage;
  const newId = deps.newId ?? cryptoUuid;
  const now = deps.now ?? Date.now;
  const realmId = (deps.realmId ?? moduleRealmId()).toLowerCase();
  if (!UUID_PATTERN.test(realmId)) throw new Error("invalid_trade_history_realm_id");
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
      if (!record) return null;
      if (typeof queueOrder === "string" && queueOrderEpoch(queueOrder) !== null) {
        return { queueOrder: queueOrder.toLowerCase(), record };
      }
      if (
        typeof queueOrder === "number" &&
        Number.isSafeInteger(queueOrder) &&
        queueOrder >= 0 &&
        queueOrder < Number.MAX_SAFE_INTEGER
      ) {
        return { queueOrder: legacyQueueOrder(queueOrder, record.id), record };
      }
      return null;
    }
    const record = recordForId(value, id);
    return record ? { queueOrder: legacyQueueOrder(openedAtOrder(record), record.id), record } : null;
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
    return [...records.values()].sort((left, right) => {
      if (left.queueOrder < right.queueOrder) return -1;
      if (left.queueOrder > right.queueOrder) return 1;
      return left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0;
    });
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
      const items = readAt(outboxKey);
      if (!items.some((item) => item.record.id === record.id)) {
        const maxPendingEpoch = items.reduce(
          (highest, item) => Math.max(highest, queueOrderEpoch(item.queueOrder) ?? -1),
          -1,
        );
        addAt(outboxKey, {
          queueOrder: nextQueueOrder(realmId, now, maxPendingEpoch),
          record,
        });
      }
      active = null;
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
