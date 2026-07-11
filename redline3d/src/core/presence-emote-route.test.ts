import { describe, expect, it, vi } from "vitest";
import { routePresenceEmote } from "./presence-emote-route";

describe("routePresenceEmote", () => {
  const event = { id: "self", kind: "laugh", nonce: 4 } as const;

  it("routes an echoed self event to the local visual", () => {
    const local = vi.fn();
    const remote = vi.fn();

    routePresenceEmote(event, "self", { local, remote });

    expect(local).toHaveBeenCalledWith("laugh");
    expect(remote).not.toHaveBeenCalled();
  });

  it("routes another driver's event to the remote renderer", () => {
    const local = vi.fn();
    const remote = vi.fn();

    routePresenceEmote({ ...event, id: "other" }, "self", { local, remote });

    expect(remote).toHaveBeenCalledWith({ id: "other", kind: "laugh", nonce: 4 });
    expect(local).not.toHaveBeenCalled();
  });

  it("contains optional renderer failures", () => {
    expect(() => routePresenceEmote(event, "self", {
      local: () => { throw new Error("visual failed"); },
      remote: vi.fn(),
    })).not.toThrow();
  });
});
