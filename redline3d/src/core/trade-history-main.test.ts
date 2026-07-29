import { beforeAll, describe, expect, it } from "vitest";

let main = "";

function between(start: string, end: string): string {
  const from = main.indexOf(start);
  const to = main.indexOf(end, from + start.length);
  expect(from, `missing main.ts marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing main.ts marker: ${end}`).toBeGreaterThan(from);
  return main.slice(from, to);
}

beforeAll(async () => {
  const fs = await import("node:fs/promises");
  main = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");
});

describe("main trade history wiring", () => {
  it("constructs account-only history from the typed API and production menu policy", () => {
    expect(main).toContain('import { showLocalEconomyMenu } from "./core/menu-visibility";');
    expect(main).toContain('import { createTradeHistoryRecorder } from "./core/trade-history-recorder";');
    expect(main).toContain('import { createTradeHistoryBridge } from "./core/trade-history-live";');
    expect(main).toContain('import { createTradeHistory } from "./ui/trade-history";');

    const setup = between("const api = createApi({ auth });", "const accountSync = createAccountSync");
    expect(setup).toContain("createTradeHistoryRecorder({");
    expect(setup).toContain("api,");
    expect(setup).toContain("wallet: () => session.address(),");
    expect(setup).toContain("createTradeHistoryBridge(tradeRecorder)");
    expect(setup).toContain("createTradeHistory(hudRoot, {");
    expect(setup).toContain('signedIn: () => identity?.mode === "privy" && signedIn,');
    expect(setup).toContain("flush: () => tradeHistoryBridge.flush(),");
    expect(setup).toContain("load: (cursor) => api.listTrades(cursor),");
    expect(setup).toContain("Capacitor?: { isNativePlatform?: () => boolean }");
    expect(setup).toMatch(/showLocalEconomyMenu\(\{\s*dev: import\.meta\.env\.DEV,\s*hostname: globalThis\.location\?\.hostname \?\? "",\s*native: capacitorNative,?\s*\}\)/);
  });

  it("passes History and local economy visibility into the product menu", () => {
    // end-marker: the crate shop comment that follows the carpicker block (renamed when the shop
    // became one surface with two entrances — lobby CRATES building + home's STORE tab)
    const picker = between("const garage = createCarPicker", "// The Crate Shop");

    expect(picker).toContain("showGarageAndUpgrades,");
    expect(picker).toContain("onHistory: () => { void tradeHistory.open(); },");
  });

  it("blocks keyboard GO while History is open", () => {
    const blocker = between("controls.setKeyLaunchBlocked", "controls.onLaunch");

    expect(blocker).toContain("tradeHistory.isOpen()");
  });

  it("begins exactly after the confirmed open loop and before the local engine", () => {
    const launch = between("for (let rebuilt = false, retried = false; ; )", "controls.onCashout");
    const confirmedOpen = launch.indexOf("opened = await session.open(");
    const begin = launch.indexOf("tradeHistoryBridge.begin({");
    const engine = launch.indexOf("engine.launch({");

    expect(confirmedOpen).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThan(confirmedOpen);
    expect(engine).toBeGreaterThan(begin);
    expect(launch.match(/tradeHistoryBridge\.begin\(/g)).toHaveLength(1);
    expect(launch).toContain("stakeBase: unitsToBase(playAmount),");
    expect(launch).toContain("entryPrice: opened.entryHuman,");
    expect(launch).toContain("entryTs: opened.entryTs,");

    const practice = between("function launchPractice()", "function finalizePractice");
    expect(practice).not.toContain("tradeHistoryBridge");
  });

  it("completes only past the authoritative idempotency guard", () => {
    const finalize = between("function finalizeSettled", "// ── guest practice rounds");

    expect(finalize).toMatch(/if \(!roundActive\) return;\s*roundActive = false;\s*tradeHistoryBridge\.settle\(info\);/);
    expect(finalize.match(/tradeHistoryBridge\.settle\(/g)).toHaveLength(1);
    expect(finalize).toContain("exitHuman: number");

    expect(main).toContain("onSettled: (info) => finalizeSettled(info)");
    expect(between("async function closeRound", "const FRIENDLY_CODES")).toContain("finalizeSettled(res)");
    expect(between("async function doFlip", "function applyFlipReconcile")).toContain("finalizeSettled(res)");
    expect(between("setInterval(async () =>", "// Boot into the 3D strip")).toContain("finalizeSettled(snap)"); // end-marker follows the poll setInterval (it tracks whatever the boot tail's opening comment says — "// Warm every mode" → "// Boot into the Slopwheels collection" → this, when boot moved back to the lobby)
  });

  it("renders the settlement balance before starting background RPC reconciliation", () => {
    const finalize = between("function finalizeSettled", "// ── guest practice rounds");
    const immediateRender = finalize.indexOf("renderKnownBalance();");
    const rpcRefresh = finalize.indexOf("session.refreshBalance");

    expect(immediateRender).toBeGreaterThanOrEqual(0);
    expect(rpcRefresh).toBeGreaterThan(immediateRender);
  });

  it("retries the outbox only after successful account hydration", () => {
    const sync = between("async function syncAccount", "// price feeds");
    const hydrate = sync.indexOf("await bindAndHydrate({");
    const flush = sync.indexOf("void tradeHistoryBridge.flush();");
    const failure = sync.indexOf("} catch (e) {");

    expect(hydrate).toBeGreaterThanOrEqual(0);
    expect(flush).toBeGreaterThan(hydrate);
    expect(failure).toBeGreaterThan(flush);
    expect(sync.match(/tradeHistoryBridge\.flush\(/g)).toHaveLength(1);
  });

  it("removes the stale stake scaffold", () => {
    expect(main).not.toContain("lastStakeUnits");
  });
});
