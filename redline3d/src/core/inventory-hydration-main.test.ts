import { beforeAll, describe, expect, it } from "vitest";

let main = "";

beforeAll(async () => {
  const fs = await import("node:fs/promises");
  main = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");
});

describe("main inventory hydration wiring", () => {
  it("reconciles the live Garage after replacing inventory from Railway", () => {
    const hydrate = main.indexOf("inventory.hydrate(snap.cars);");
    const reconcile = main.indexOf("garageForHydration?.reconcileOwnership((name) => inventory.owns(name));");
    const bridge = main.indexOf("garageForHydration = garage;");

    expect(hydrate).toBeGreaterThanOrEqual(0);
    expect(reconcile).toBeGreaterThan(hydrate);
    expect(bridge).toBeGreaterThan(reconcile);
  });
});
