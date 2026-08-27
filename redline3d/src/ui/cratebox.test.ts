// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
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

  test("each crate discloses pity toward its top tier", () => {
    const parent = document.createElement("div");
    createCrateBox(parent, stubDeps());
    const lines = [...parent.querySelectorAll("[data-pity]")].map((el) => el.textContent);
    expect(lines[0]).toMatch(/Pity 0\/12 → RARE/);
    expect(lines[1]).toMatch(/Pity 0\/20 → LEGENDARY/);
    expect(lines[2]).toMatch(/Pity 0\/8 → LEGENDARY/);
  });

  test("the Gold crate discloses its 25% Legendary chance", () => {
    const parent = document.createElement("div");
    createCrateBox(parent, stubDeps());
    const gold = colByName(parent, "Gold");
    const shown = [...gold.querySelectorAll(".cb-col-od")].map((o) => o.textContent);
    expect(shown).toContain("25%"); // the headline gold number a buyer is paying for
  });

  test("keeps purchase controls aligned when crate odds wrap", () => {
    const parent = document.createElement("div");
    createCrateBox(parent, stubDeps());
    const styles = [...document.head.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .find((text) => text.includes(".cb-col-odds")) ?? "";

    expect(styles).toMatch(/\.cb-col-odds\{[^}]*min-height:21px/);
    expect(styles).toMatch(/\.cb-col-odds\{[^}]*align-content:center/);
    expect(styles).toMatch(/\.cb-col-buy\{[^}]*margin-top:auto/);
  });

  test("offers Silver for 0.1 SOL and Gold for 0.2 SOL, with no SOL Wooden option", () => {
    const parent = document.createElement("div");
    createCrateBox(parent, stubDeps());

    expect(parent.querySelector('[data-sol="wooden"]')).toBeNull();
    expect(parent.querySelector('[data-sol="silver"]')?.textContent).toBe("0.1 SOL");
    expect(parent.querySelector('[data-sol="gold"]')?.textContent).toBe("0.2 SOL");
    expect(parent.querySelector("[data-usd]")).toBeNull();
  });
});

describe("SOL crate purchases", () => {
  const paidDeps = (overrides: Partial<CrateBoxDeps> = {}): CrateBoxDeps => ({
    ...stubDeps(),
    cars: () => [{ name: "Common", rarity: 1, url: "/common.glb" }],
    vrfRequired: () => true,
    vrfDraws: () => async () => [0, 0, 1, 0],
    buyWithSol: async () => "confirmed-signature",
    ...overrides,
  });

  test("does not ask a guest wallet to pay", () => {
    const parent = document.createElement("div");
    const buyWithSol = vi.fn(async () => "must-not-run");
    const onVrfFail = vi.fn();
    createCrateBox(parent, paidDeps({
      vrfRequired: () => false,
      vrfDraws: () => null,
      buyWithSol,
      onVrfFail,
    }));

    parent.querySelector<HTMLButtonElement>('[data-sol="silver"]')?.click();

    expect(buyWithSol).not.toHaveBeenCalled();
    expect(onVrfFail).toHaveBeenCalledWith(expect.stringContaining("Sign in"));
  });

  test("grants only after the SOL transfer confirms and VRF resolves", async () => {
    const parent = document.createElement("div");
    const events: string[] = [];
    const buyWithSol = vi.fn(async () => { events.push("paid"); return "confirmed-signature"; });
    const grantCar = vi.fn(() => { events.push("granted"); return true; });
    createCrateBox(parent, paidDeps({ buyWithSol, grantCar }));

    parent.querySelector<HTMLButtonElement>('[data-sol="silver"]')?.click();
    await vi.waitFor(() => expect(grantCar).toHaveBeenCalledTimes(1));

    expect(buyWithSol).toHaveBeenCalledWith("silver", 0.1);
    expect(events).toEqual(["paid", "granted"]);
  });

  test("retries a paid VRF pull without charging a second time", async () => {
    const parent = document.createElement("div");
    const buyWithSol = vi.fn(async () => "confirmed-signature");
    const grantCar = vi.fn(() => true);
    const onVrfFail = vi.fn();
    let attempts = 0;
    createCrateBox(parent, paidDeps({
      buyWithSol,
      grantCar,
      onVrfFail,
      vrfDraws: () => async () => {
        attempts++;
        if (attempts === 1) throw new Error("vrf_timeout");
        return [0, 0, 1, 0];
      },
    }));

    const buy = parent.querySelector<HTMLButtonElement>('[data-sol="silver"]')!;
    buy.click();
    await vi.waitFor(() => expect(onVrfFail).toHaveBeenCalledWith(expect.stringContaining("without another charge")));
    buy.click();
    await vi.waitFor(() => expect(grantCar).toHaveBeenCalledTimes(1));

    expect(buyWithSol).toHaveBeenCalledTimes(1);
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
