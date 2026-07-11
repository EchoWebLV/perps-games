import { afterEach, describe, expect, it, vi } from "vitest";
import { createBootReveal } from "./boot-reveal";

describe("createBootReveal", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["loaded", "failed"] as const)("reveals once for %s", (outcome) => {
    vi.useFakeTimers();
    const reveal = vi.fn();
    const gate = createBootReveal({ reveal, timeoutMs: 20_000 });
    gate.modelSettled(outcome);
    gate.modelSettled(outcome);
    vi.advanceTimersByTime(20_000);
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(outcome);
  });

  it("reveals a timed-out fallback at exactly 20 seconds", () => {
    vi.useFakeTimers();
    const reveal = vi.fn();
    createBootReveal({ reveal, timeoutMs: 20_000 });
    vi.advanceTimersByTime(19_999);
    expect(reveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reveal).toHaveBeenCalledWith("timed_out");
  });
});
