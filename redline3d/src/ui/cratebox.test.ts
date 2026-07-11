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

describe("welcome crate randomness policy", () => {
  test("a free welcome crate never requires the new wallet to fund a VRF transaction", () => {
    const usesVrf = (crateboxModule as unknown as {
      shouldUseVrfForOpen?: (free: boolean, hasProvider: boolean) => boolean;
    }).shouldUseVrfForOpen;

    expect(usesVrf?.(true, true)).toBe(false);
    expect(usesVrf?.(false, true)).toBe(true);
    expect(usesVrf?.(false, false)).toBe(false);
  });
});

describe("VRF failure messages", () => {
  test("separates an unfunded wallet from an oracle timeout", () => {
    const messageFor = (crateboxModule as unknown as {
      vrfFailureMessage?: (error: unknown) => string;
    }).vrfFailureMessage;

    expect(messageFor?.(new Error("Attempt to debit an account but found no record of a prior credit")))
      .toContain("wallet needs devnet SOL");
    expect(messageFor?.(new Error("vrf_timeout"))).toContain("oracle timed out");
  });
});
