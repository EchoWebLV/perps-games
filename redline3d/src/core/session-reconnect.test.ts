import { describe, expect, it, vi } from "vitest";
import { createReconnectLoop } from "./session-reconnect";

describe("createReconnectLoop", () => {
  it("schedules one retry after a failed session init", () => {
    const timer: { callback: (() => void) | null } = { callback: null };
    const retry = vi.fn();
    const loop = createReconnectLoop({
      setTimeout: ((cb: () => void) => {
        timer.callback = cb;
        return 1;
      }) as any,
      clearTimeout: vi.fn() as any,
    });

    loop.schedule(retry);
    loop.schedule(retry);

    expect(retry).not.toHaveBeenCalled();
    timer.callback?.();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("clears a pending retry after session init succeeds", () => {
    const clearTimeout = vi.fn();
    const loop = createReconnectLoop({
      setTimeout: (() => 7) as any,
      clearTimeout: clearTimeout as any,
    });

    loop.schedule(() => {});
    loop.reset();

    expect(clearTimeout).toHaveBeenCalledWith(7);
  });
});
