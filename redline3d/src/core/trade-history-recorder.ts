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

export function createTradeHistoryRecorder(deps: {
  api: Pick<Api, "recordTrade">;
  wallet: () => string;
  store?: Storage;
  newId?: () => string;
}): TradeHistoryRecorder {
  const store = deps.store ?? localStorage;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let active: (ActiveTradeDraft & { id: string; outboxKey: string }) | null = null;
  let flushing: Promise<void> | null = null;
  const key = () => PREFIX + deps.wallet();
  const readAt = (outboxKey: string): TradeRecordInput[] => {
    try {
      const value = JSON.parse(store.getItem(outboxKey) ?? "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const writeAt = (outboxKey: string, items: TradeRecordInput[]) => items.length
    ? store.setItem(outboxKey, JSON.stringify(items))
    : store.removeItem(outboxKey);

  return {
    begin(draft) {
      if (deps.wallet()) active = { ...draft, id: newId(), outboxKey: key() };
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
      if (flushing) return flushing;
      const outboxKey = key();
      flushing = (async () => {
        const items = readAt(outboxKey);
        for (const item of items) {
          try {
            await deps.api.recordTrade(item);
            writeAt(outboxKey, readAt(outboxKey).filter((pending) => pending.id !== item.id));
          } catch {
            break;
          }
        }
      })().finally(() => { flushing = null; });
      return flushing;
    },
    pending: () => readAt(key()).length,
  };
}
