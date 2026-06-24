export type TimedSettlement<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timeout" };

const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function settleWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  delay: (ms: number) => Promise<void> = defaultDelay,
  onTimeout?: () => void,
): Promise<TimedSettlement<T>> {
  const settled = promise.then(
    (value): TimedSettlement<T> => ({ status: "resolved", value }),
    (error): TimedSettlement<T> => ({ status: "rejected", error }),
  );
  const timeout = delay(timeoutMs).then<TimedSettlement<T>>(() => {
    onTimeout?.();
    return { status: "timeout" };
  });
  return Promise.race([settled, timeout]);
}
