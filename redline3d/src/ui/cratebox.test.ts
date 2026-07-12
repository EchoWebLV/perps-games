// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { createCrateBox, type CrateBoxDeps } from "./cratebox";
import * as crateboxModule from "./cratebox";
import { CRATES } from "../core/crate";

// Minimal deps — the shop rows (incl. odds) are built at construction, before any WebGL/open().
const stubDeps = (): CrateBoxDeps => ({
  cars: () => [],
  grantCar: () => true,
  unlockUI: () => {},
  coins: () => 0,
  spend: () => true,
  addScrap: () => {},
  lockedLevels: () => [],
  grantLevel: () => {},
  levelInfo: () => ({ name: "", sky: ["#000", "#000"], disc: "#000", grid: ["#000", "#000"] }),
  lowTier: false,
});

const colByName = (parent: HTMLElement, name: string): HTMLElement =>
  [...parent.querySelectorAll<HTMLElement>(".cb-col")].find(
    (el) => el.querySelector(".cb-col-nm")?.textContent === name,
  )!;

describe("crate shop odds disclosure", () => {
  test("each crate discloses its per-tier drop odds at the point of purchase", () => {
    const parent = document.createElement("div");
    createCrateBox(parent, stubDeps());
    // odds belong HERE (the shop) — one % chip per weighted tier of each crate
    CRATES.forEach((crate) => {
      const col = colByName(parent, crate.name.replace(" Crate", ""));
      const shown = [...col.querySelectorAll(".cb-col-od")].map((o) => o.textContent);
      expect(shown.length).toBe(Object.keys(crate.tierWeights).length);
      Object.values(crate.tierWeights).forEach((w) => expect(shown).toContain(`${w}%`));
    });
  });

  test("the Gold crate discloses its 25% Legendary chance", () => {
    const parent = document.createElement("div");
    createCrateBox(parent, stubDeps());
    const gold = colByName(parent, "Gold");
    const shown = [...gold.querySelectorAll(".cb-col-od")].map((o) => o.textContent);
    expect(shown).toContain("25%"); // the headline gold number a buyer is paying for
  });
});

describe("crate randomness policy", () => {
  test("requires VRF for every signed-in crate, including free welcome crates", () => {
    const mode = (crateboxModule as unknown as {
      crateRandomnessMode?: (required: boolean, hasProvider: boolean) => "vrf" | "client" | "blocked";
    }).crateRandomnessMode;

    expect(mode?.(true, true)).toBe("vrf");
    expect(mode?.(true, false)).toBe("blocked");
    expect(mode?.(false, false)).toBe("client");
  });

  test("completes a free welcome claim before applying its VRF reward", async () => {
    const complete = (crateboxModule as unknown as {
      completeVrfReward?: (
        free: boolean,
        completeGift: (() => Promise<boolean>) | undefined,
        applyReward: () => boolean,
      ) => Promise<boolean>;
    }).completeVrfReward!;
    const events: string[] = [];

    const revealed = await complete(
      true,
      async () => { events.push("claim"); return true; },
      () => { events.push("reward"); return true; },
    );

    expect(revealed).toBe(true);
    expect(events).toEqual(["claim", "reward"]);
  });

  test("does not apply a welcome reward when atomic completion loses", async () => {
    const complete = (crateboxModule as unknown as {
      completeVrfReward?: (
        free: boolean,
        completeGift: (() => Promise<boolean>) | undefined,
        applyReward: () => boolean,
      ) => Promise<boolean>;
    }).completeVrfReward!;
    let grants = 0;

    await expect(complete(true, async () => false, () => { grants++; return true; })).resolves.toBe(false);
    expect(grants).toBe(0);
  });
});

describe("VRF failure messages", () => {
  test("separates an unfunded wallet from an oracle timeout", () => {
    const messageFor = (crateboxModule as unknown as {
      vrfFailureMessage?: (error: unknown, coinsHeld?: boolean) => string;
    }).vrfFailureMessage;

    expect(messageFor?.(new Error("Attempt to debit an account but found no record of a prior credit")))
      .toContain("wallet needs devnet SOL");
    expect(messageFor?.(new Error("vrf_timeout"))).toContain("oracle timed out");
    expect(messageFor?.(new Error("vrf_timeout"), false)).not.toContain("coins were restored");
    expect(messageFor?.(new Error("vrf_timeout"), true)).toContain("coins were restored");
  });
});
