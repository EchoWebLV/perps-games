// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { createCrateBox, type CrateBoxDeps } from "./cratebox";
import * as crateboxModule from "./cratebox";
import { CRATES, drawsFromSeed } from "../core/crate";

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
    lowTier: true, // static <img> reveal — jsdom has no WebGL context for the live canvas
    cars: () => [{ name: "Common", rarity: 1, url: "/common.glb" }],
    rail: () => "solana",          // devnet SOL purchases live on the parked Solana rail
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

// ── EVM rail: server commit-reveal crates ───────────────────────────────────────────────────────
const SEED = "07".repeat(32);
const NONCE = "5a".repeat(16);
const COMMITMENT = createHash("sha256")
  .update(Buffer.from(SEED, "hex")).update(Buffer.from(NONCE, "hex")).digest("hex");
const DRAWS = drawsFromSeed(SEED, 4);

const openResult = (over: Record<string, unknown> = {}) => ({
  carId: "Common", isNew: true, count: 1, scrap: 25, scrapTotal: 25, coins: 750, levelKey: null,
  pity: { wooden: 0, silver: 0, gold: 0 },
  reveal: { seedHex: SEED, nonceHex: NONCE, commitment: COMMITMENT },
  draws: DRAWS,
  ...over,
});

const provenDeps = (overrides: Partial<CrateBoxDeps> = {}): CrateBoxDeps => ({
  ...stubDeps(),
  lowTier: true, // static <img> reveal — no live WebGL context under jsdom
  cars: () => [{ name: "Common", rarity: 1, url: "/common.glb" }],
  coins: () => 5000,
  rail: () => "evm",
  vrfRequired: () => true,
  crateCommit: async () => ({ commitId: "commit-1", commitment: COMMITMENT }),
  openVerified: async () => openResult(),
  ...overrides,
});

const buyWooden = (parent: HTMLElement) =>
  parent.querySelector<HTMLButtonElement>('[data-open="wooden"]')!.click();

describe("commit-reveal crate opens (EVM rail)", () => {
  test("publishes the server's commitment while the crate is still shaking", async () => {
    const parent = document.createElement("div");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    createCrateBox(parent, provenDeps({
      openVerified: async () => { await gate; return openResult(); },
    }));

    buyWooden(parent);
    // the commitment must be on screen BEFORE the outcome comes back — otherwise it proves nothing
    await vi.waitFor(() => expect(parent.querySelector('[data-cb="commit"]')).not.toBeNull());
    expect(parent.querySelector<HTMLElement>('[data-cb="commit"]')!.dataset.commitment).toBe(COMMITMENT);
    expect(parent.querySelector(".cb-card, .cb-plate")).toBeNull(); // nothing revealed yet
    release();
  });

  test("spends a commit per open and never ships VRF bytes on this rail", async () => {
    const parent = document.createElement("div");
    const openVerified = vi.fn(async (_p: Record<string, unknown>) => openResult());
    const crateCommit = vi.fn(async () => ({ commitId: "commit-1", commitment: COMMITMENT }));
    createCrateBox(parent, provenDeps({ openVerified: openVerified as CrateBoxDeps["openVerified"], crateCommit }));

    buyWooden(parent);
    await vi.waitFor(() => expect(openVerified).toHaveBeenCalledTimes(1));

    expect(crateCommit).toHaveBeenCalledTimes(1);
    const sent = openVerified.mock.calls[0][0];
    expect(sent).toEqual({ crateKey: "wooden", payment: "coins", commitId: "commit-1" });
    expect(sent.vrfBytes).toBeUndefined();
  });

  test("badges a verified pull provably fair and applies the reward", async () => {
    const parent = document.createElement("div");
    const applyVerified = vi.fn();
    createCrateBox(parent, provenDeps({ applyVerified }));

    buyWooden(parent);
    await vi.waitFor(() => expect(applyVerified).toHaveBeenCalledTimes(1));

    const badge = parent.querySelector('[data-cb="proof-badge"]');
    expect(badge?.textContent).toContain("provably fair");
    expect(parent.textContent).not.toContain("MagicBlock VRF");
    expect(parent.querySelector<HTMLElement>('[data-cb="proof"]')!.dataset.commitment).toBe(COMMITMENT);
  });

  test("a seed that does not hash to the commitment fails verification and grants nothing", async () => {
    const parent = document.createElement("div");
    const applyVerified = vi.fn();
    const onVrfFail = vi.fn();
    createCrateBox(parent, provenDeps({
      applyVerified,
      onVrfFail,
      openVerified: async () => openResult({
        reveal: { seedHex: "08".repeat(32), nonceHex: NONCE, commitment: COMMITMENT },
      }),
    }));

    buyWooden(parent);
    await vi.waitFor(() => expect(parent.querySelector('[data-cb="verify-failed"]')).not.toBeNull());

    expect(parent.querySelector('[data-cb="verify-failed"]')!.textContent).toContain("verification failed");
    expect(applyVerified).not.toHaveBeenCalled();
    expect(parent.querySelector('[data-cb="proof-badge"]')).toBeNull();
    expect(onVrfFail).toHaveBeenCalledWith(expect.stringContaining("commitment"));
  });

  test("draws the revealed seed cannot produce fail verification too", async () => {
    const parent = document.createElement("div");
    const applyVerified = vi.fn();
    createCrateBox(parent, provenDeps({
      applyVerified,
      openVerified: async () => openResult({ draws: [0.5, 0.5, 0.5, 0.5] }),
    }));

    buyWooden(parent);
    await vi.waitFor(() => expect(parent.querySelector('[data-cb="verify-failed"]')).not.toBeNull());
    expect(applyVerified).not.toHaveBeenCalled();
  });

  test("a response with no proof at all is refused, not trusted", async () => {
    const parent = document.createElement("div");
    const applyVerified = vi.fn();
    createCrateBox(parent, provenDeps({
      applyVerified,
      openVerified: async () => openResult({ reveal: undefined, draws: undefined }),
    }));

    buyWooden(parent);
    await vi.waitFor(() => expect(parent.querySelector('[data-cb="verify-failed"]')).not.toBeNull());
    expect(applyVerified).not.toHaveBeenCalled();
  });

  test("blocks an account-backed open when no commit provider is wired", async () => {
    const parent = document.createElement("div");
    const openVerified = vi.fn(async () => openResult());
    const onVrfFail = vi.fn();
    createCrateBox(parent, provenDeps({ crateCommit: undefined, openVerified, onVrfFail }));

    buyWooden(parent);

    expect(openVerified).not.toHaveBeenCalled();
    expect(onVrfFail).toHaveBeenCalledWith(expect.stringContaining("Provably fair"));
  });

  test("a guest still practices with client RNG and reaches no server", async () => {
    const parent = document.createElement("div");
    const openVerified = vi.fn(async () => openResult());
    const grantCar = vi.fn(() => true);
    createCrateBox(parent, provenDeps({ vrfRequired: () => false, openVerified, grantCar }));

    buyWooden(parent);
    await vi.waitFor(() => expect(grantCar).toHaveBeenCalledTimes(1));
    expect(openVerified).not.toHaveBeenCalled();
  });

  test("refuses a SOL purchase on this rail instead of charging a parked wallet", () => {
    const parent = document.createElement("div");
    const buyWithSol = vi.fn(async () => "must-not-run");
    const onVrfFail = vi.fn();
    createCrateBox(parent, provenDeps({ buyWithSol, onVrfFail }));

    parent.querySelector<HTMLButtonElement>('[data-sol="silver"]')?.click();

    expect(buyWithSol).not.toHaveBeenCalled();
    expect(onVrfFail).toHaveBeenCalledWith(expect.stringContaining("temporarily unavailable"));
  });
});

describe("randomness policy per rail", () => {
  test("an account-backed EVM crate is proven or blocked — never browser RNG", () => {
    const mode = (crateboxModule as unknown as {
      provenRandomnessMode?: (accountBacked: boolean, canProve: boolean) => "vrf" | "client" | "blocked";
    }).provenRandomnessMode!;

    expect(mode(true, true)).toBe("vrf");
    expect(mode(true, false)).toBe("blocked");
    expect(mode(false, false)).toBe("client");
    expect(mode(false, true)).toBe("client"); // a guest has no account to charge
  });
});
