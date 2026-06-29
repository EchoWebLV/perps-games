import { describe, it, expect, vi } from "vitest";
import { createLeverSync } from "./lever-sync";

// a controllable async: each call returns a promise we resolve by hand
function deferredSend() {
  const calls: number[] = [];
  let release: (() => void) | null = null;
  const send = vi.fn(async (v: number) => {
    calls.push(v);
    await new Promise<void>((r) => { release = r; });
  });
  return { send, calls, flush: () => { const r = release; release = null; r?.(); } };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createLeverSync", () => {
  it("collapses a burst that arrives mid-flight to first + latest only", async () => {
    const d = deferredSend();
    const sync = createLeverSync({ send: d.send });
    sync.submit(100);          // starts send(100)
    await tick();
    sync.submit(500);          // queued while 100 in flight
    sync.submit(1000);         // overwrites the queued value
    sync.submit(2000);         // overwrites again — only 2000 should survive
    expect(d.calls).toEqual([100]);
    d.flush(); await tick();   // 100 resolves → drain sends the latest (2000), skipping 500/1000
    expect(d.calls).toEqual([100, 2000]);
    d.flush(); await tick();
    expect(d.calls).toEqual([100, 2000]);
    expect(sync.pending()).toBe(false);
  });

  it("dedupes a repeat of the last-sent value (no duplicate tx)", async () => {
    const d = deferredSend();
    const sync = createLeverSync({ send: d.send });
    sync.submit(300); await tick();
    d.flush(); await tick();        // 300 sent + done; lastSent = 300
    sync.submit(300);               // same value → no-op
    await tick();
    expect(d.calls).toEqual([300]);
  });

  it("sends distinct sequential values when not overlapping", async () => {
    const d = deferredSend();
    const sync = createLeverSync({ send: d.send });
    sync.submit(100); await tick(); d.flush(); await tick();
    sync.submit(200); await tick(); d.flush(); await tick();
    expect(d.calls).toEqual([100, 200]);
  });

  it("swallows a send rejection and keeps draining later submits", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("rpc 429"))
      .mockResolvedValueOnce(undefined);
    const sync = createLeverSync({ send });
    sync.submit(100); await tick(); await tick();   // first rejects, swallowed
    sync.submit(200); await tick(); await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(200);
  });
});
