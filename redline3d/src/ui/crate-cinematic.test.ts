// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createCrateCinematic } from "./crate-cinematic";

describe("crate cinematic", () => {
  it("runs drop → shake → rip → flip and lands the reveal html", async () => {
    vi.useFakeTimers();
    const stage = document.createElement("div");
    const cine = createCrateCinematic(stage);
    const done = cine.play({ color: "#ffcf5a", rarity: 5, revealHtml: "<div data-card>ORION</div>" });
    expect(cine.phase()).toBe("drop");
    await vi.advanceTimersByTimeAsync(380);
    expect(cine.phase()).toBe("shake");
    await vi.advanceTimersByTimeAsync(400);
    expect(cine.phase()).toBe("rip");
    await vi.advanceTimersByTimeAsync(260);
    expect(cine.phase()).toBe("flip");
    expect(stage.textContent).toContain("ORION");
    await vi.advanceTimersByTimeAsync(480);
    await done;
    expect(cine.phase()).toBe("idle");
    vi.useRealTimers();
  });
});
