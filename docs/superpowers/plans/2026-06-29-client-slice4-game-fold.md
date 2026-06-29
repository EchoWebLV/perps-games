# Client Slice 4 — Fold the on-chain round into the 3D game — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real 3D game (`redline3d/index.html` + `src/main.ts`) play on real on-chain money by routing its round loop (open/flip/lever/close + native crank) and its USDC play balance through the already-built `src/chain/chain-round.ts`, replacing the server-mark settlement path; plus a `delegate()` hardening so a stale/foreign delegated house fails clearly.

**Architecture:** A new thin `createGameSession` controller wraps `chain-round` + a single-flight lever sync and owns the ER-session lifecycle (delegated flag, cached balance, crank-armed flag). `main.ts` keeps its entire visual/HUD/lobby/garage shell and swaps only the round money spine: server-mark → local-engine ×, `roundSync` → `session`, server-ledger balance → on-chain play balance. The local `RoundEngine` stays the sole driver of the smooth visual ×; the on-chain `Round` is the only money truth, surfaced by a `readRound` terminal poll and the authoritative `close()` payout. Leverage is instant-local + coalesced-to-latest on-chain (accepted divergence).

**Tech Stack:** TypeScript, Vite, Three.js (existing game); `@coral-xyz/anchor` 0.31 + `@solana/web3.js` 1.98 (chain layer, already built); Vitest (unit + gated devnet integration); Claude Preview (browser verification). Devnet, dev-keypair wallet.

**Spec:** `docs/superpowers/specs/2026-06-29-client-slice4-game-fold-design.md`
**Reference wiring (proven, do not modify):** `redline3d/src/onchain-main.ts` (the slim debug UI). Keep `onchain.html` as the debug entry.

---

## File Structure

- **Create** `redline3d/src/chain/lever-sync.ts` — single-flight, latest-wins async sender (the coalesce-to-latest leverage engine). One responsibility: never more than one send in flight + one pending.
- **Create** `redline3d/src/chain/lever-sync.test.ts` — unit tests (deterministic, fake deferred sends).
- **Create** `redline3d/src/chain/game-session.ts` — `createGameSession` controller: owns the ER-session lifecycle and wraps `chain-round` + `lever-sync`. Returns plain data; never touches the DOM/HUD.
- **Create** `redline3d/src/chain/game-session.test.ts` — unit tests against a fake `ChainRound`.
- **Modify** `redline3d/src/chain/chain-round.ts` — add `DelegateBusyError`, `DelegateState`, `classifyDelegateState`, and harden `delegate()`.
- **Modify** `redline3d/src/chain/chain-round.test.ts` — add `classifyDelegateState` unit tests.
- **Modify** `redline3d/src/chain/chain-round.devnet.test.ts` — add a gated delegate-busy + reuse integration test.
- **Modify** `redline3d/src/ui/wallet.ts` — optional on-chain footer (play balance + End session + Withdraw), gated behind a new `onchain?` opt so the off-chain build is unchanged when it's absent.
- **Modify** `redline3d/src/main.ts` — the fold (one coherent task; the file must `tsc`-pass at commit).

**Conventions used throughout (define once, reuse):**
- On-chain USDC base units ↔ display cents: factor `USDC_PER_CENT = 10 ** (CHAIN.USDC_DECIMALS - 2)` = `10_000`. `centsToBase(c) = c * 10_000`; `baseToCents(b) = Number(b / 10_000n)`. (`controls.playAmount()` is cents; `usd()` takes cents; on-chain stake/balance/payout are base units.)
- On-chain `entryHuman` (a human price) seeds `engine.launch({ entryRaw })` and `round.entryPx` — never the raw mantissa, or every round insta-liquidates.
- On-chain leverage bound is RMAX=2000 (the program's cap). The off-chain server capped at 1000; the fold restores the full 2000 dial (the standing product directive). Both clamp sites move `1000 → 2000`.

---

## Task 1: `delegate()` hardening — typed busy error + ownership classification

**Files:**
- Modify: `redline3d/src/chain/chain-round.ts` (add exports near the top types; rewrite `delegate()` ~157-162)
- Test: `redline3d/src/chain/chain-round.test.ts`

Background: the `HouseBalance` PDA `[b"house", mint]` is shared per-mint, so only one delegated session per mint can exist at a time. A session left delegated blocks the next wallet's `delegateSession` with a raw `ExternalAccountDataModified`. We classify the three PDAs' on-chain owners first and either reuse our own live session, send a fresh delegate, or throw a typed `delegate_busy`.

- [ ] **Step 1: Write the failing test**

Add to `redline3d/src/chain/chain-round.test.ts` (it already imports from `./chain-round`):

```ts
import { classifyDelegateState, DelegateBusyError } from "./chain-round";
import { CHAIN } from "./config";

describe("classifyDelegateState", () => {
  const DEL = CHAIN.DELEGATION_PROGRAM;
  const PROG = CHAIN.PROGRAM_ID;

  it("reuse when all three PDAs are already delegated (our own live session)", () => {
    expect(classifyDelegateState({ player: DEL, house: DEL, round: DEL })).toBe("reuse");
  });

  it("fresh when none are delegated (fresh wallet / clean state — nulls allowed)", () => {
    expect(classifyDelegateState({ player: null, house: PROG, round: null })).toBe("fresh");
    expect(classifyDelegateState({ player: PROG, house: PROG, round: PROG })).toBe("fresh");
  });

  it("busy when the shared house is delegated but our PDAs are still on L1", () => {
    expect(classifyDelegateState({ player: PROG, house: DEL, round: PROG })).toBe("busy");
  });

  it("busy on a torn mid-delegation state", () => {
    expect(classifyDelegateState({ player: DEL, house: DEL, round: PROG })).toBe("busy");
  });

  it("DelegateBusyError carries a typed code", () => {
    const e = new DelegateBusyError("nope");
    expect(e.code).toBe("delegate_busy");
    expect(e.message).toBe("nope");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd redline3d && npx vitest run src/chain/chain-round.test.ts`
Expected: FAIL — `classifyDelegateState`/`DelegateBusyError` are not exported.

- [ ] **Step 3: Add the error class + classifier to `chain-round.ts`**

Insert after the `OUTCOME` const (after line 31, before `export interface RoundSnap`):

```ts
/** A delegate attempt that can't proceed because the shared house is held (foreign or torn). */
export class DelegateBusyError extends Error {
  readonly code = "delegate_busy" as const;
  constructor(message: string) { super(message); this.name = "DelegateBusyError"; }
}

export type DelegateState = "reuse" | "fresh" | "busy";

/**
 * Classify the three raider PDAs' on-chain owners before delegating:
 *  - all delegated  → "reuse" (our own stale-but-live session; skip the delegate tx)
 *  - none delegated → "fresh" (normal delegate; nulls = not-yet-created PDAs count as not-delegated)
 *  - anything else  → "busy"  (another wallet holds the shared house, or torn mid-delegation)
 */
export function classifyDelegateState(owners: {
  player: PublicKey | null; house: PublicKey | null; round: PublicKey | null;
}): DelegateState {
  const del = (o: PublicKey | null) => !!o && o.equals(CHAIN.DELEGATION_PROGRAM);
  const p = del(owners.player), h = del(owners.house), r = del(owners.round);
  if (p && h && r) return "reuse";
  if (!p && !h && !r) return "fresh";
  return "busy";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd redline3d && npx vitest run src/chain/chain-round.test.ts`
Expected: PASS (all chain-round pure-helper tests + the new ones).

- [ ] **Step 5: Harden `delegate()` to use the classifier**

Replace the existing `delegate()` method (currently ~157-162) with:

```ts
    async delegate() {
      const [pi, hi, ri] = await Promise.all([
        baseConn.getAccountInfo(pdas.player),
        baseConn.getAccountInfo(pdas.house),
        baseConn.getAccountInfo(pdas.round),
      ]);
      const state = classifyDelegateState({ player: pi?.owner ?? null, house: hi?.owner ?? null, round: ri?.owner ?? null });
      if (state === "reuse") return; // our own session is already live on the ER — nothing to send
      if (state === "busy") {
        throw new DelegateBusyError("Session busy — another player holds the table, or end your previous session and try again.");
      }
      try {
        await send(baseConn, program.methods.delegateSession().accountsPartial({
          payer: owner, mint, player: pdas.player, house: pdas.house, round: pdas.round,
        }).remainingAccounts([{ pubkey: CHAIN.VALIDATOR, isSigner: false, isWritable: false }]), 400_000);
      } catch (e) {
        // race: the house was grabbed between our ownership read and our send.
        if (String((e as Error).message).includes("ExternalAccountDataModified")) {
          throw new DelegateBusyError("Session busy — the table was just taken. Try again in a moment.");
        }
        throw e;
      }
      await pollOwner(CHAIN.DELEGATION_PROGRAM, "delegate", 25, 1000);
    },
```

- [ ] **Step 6: Typecheck**

Run: `cd redline3d && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add redline3d/src/chain/chain-round.ts redline3d/src/chain/chain-round.test.ts
git commit -m "feat(chain): harden delegate() with typed delegate_busy + ownership classify"
```

---

## Task 2: `lever-sync.ts` — single-flight, latest-wins on-chain leverage sync

**Files:**
- Create: `redline3d/src/chain/lever-sync.ts`
- Test: `redline3d/src/chain/lever-sync.test.ts`

This is the coalesce-to-latest engine from the spec: at most one send in flight plus one pending (always the newest value); intermediate values during a fast throttle sweep are skipped; a value equal to the last-sent is a no-op (no duplicate tx).

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/chain/lever-sync.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd redline3d && npx vitest run src/chain/lever-sync.test.ts`
Expected: FAIL — `./lever-sync` does not exist.

- [ ] **Step 3: Implement `lever-sync.ts`**

Create `redline3d/src/chain/lever-sync.ts`:

```ts
export interface LeverSync {
  /** record the newest desired leverage; drains in the background, coalescing to latest */
  submit(lev: number): void;
  /** true while a send is in flight or a value is queued */
  pending(): boolean;
}

/**
 * Single-flight, latest-wins. Guarantees at most one `send` in flight plus one pending
 * (= the newest value submitted). Values submitted during an in-flight send collapse to the
 * latest; a value equal to the last one actually sent is a no-op. A rejected send is swallowed
 * (the next submit re-drives), so a transient RPC error never wedges the queue.
 */
export function createLeverSync(opts: { send: (lev: number) => Promise<void> }): LeverSync {
  let inFlight = false;
  let queued: number | null = null;
  let lastSent: number | null = null;

  async function drain(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      while (queued !== null && queued !== lastSent) {
        const target = queued;
        queued = null;          // a submit during the await below re-sets this to the newest
        lastSent = target;
        try { await opts.send(target); } catch { /* swallow; next submit re-drives */ }
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    submit(lev) { queued = lev; void drain(); },
    pending: () => inFlight || queued !== null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd redline3d && npx vitest run src/chain/lever-sync.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/lever-sync.ts redline3d/src/chain/lever-sync.test.ts
git commit -m "feat(chain): single-flight latest-wins lever sync (coalesce-to-latest)"
```

---

## Task 3: `game-session.ts` — the on-chain session controller

**Files:**
- Create: `redline3d/src/chain/game-session.ts`
- Test: `redline3d/src/chain/game-session.test.ts`

Owns the ER-session lifecycle so `main.ts` stays a thin caller: build the chain handle from the dev-keypair port, `ensureSession` (buy-in-if-empty + hardened delegate), `open` (+ best-effort crank arm), `noteLeverage` (background coalesced on-chain `lever`, surfacing a terminal-first settle via `onSettled`), `flip`, `close`, terminal `poll`, `endSession`, `withdraw`. Returns plain data; never imports the DOM/HUD. A `chain`/`address` injection seam lets the unit test drive a fake `ChainRound`.

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/chain/game-session.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createGameSession } from "./game-session";
import type { ChainRound } from "./chain-round";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const MINT = new PublicKey("8tZXkKuat9KoisUjFkq4kBUa1p746Mn4tj4i3st5Th1Y");

function fakeChain(over: Partial<ChainRound> = {}): ChainRound {
  return {
    address: "Fake111",
    readPlayerBalance: vi.fn(async () => 0n),
    readRoundStatus: vi.fn(async () => 0),
    readRound: vi.fn(async () => null),
    buyIn: vi.fn(async () => {}),
    ensureRoundInited: vi.fn(async () => {}),
    delegate: vi.fn(async () => {}),
    open: vi.fn(async () => ({ entryRaw: 0n, entryExpo: 8, entryHuman: 60000, deadlineTs: 0 })),
    close: vi.fn(async () => ({ outcome: 0, outcomeName: "cashout", payout: 1_500_000n, exitRaw: 0n, exitHuman: 0, balance: 4_500_000n })),
    flip: vi.fn(async () => ({ settled: false, banked: 0n, dir: -1, lev: 100, entryHuman: 60000 })),
    lever: vi.fn(async () => ({ settled: false, banked: 0n, dir: 1, lev: 2000, entryHuman: 60000 })),
    scheduleCrank: vi.fn(async () => {}),
    forceClose: vi.fn(async () => ({ outcome: 3, outcomeName: "time", payout: 0n, exitRaw: 0n, exitHuman: 0, balance: 0n })),
    commitAndUndelegate: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    ...over,
  };
}

describe("createGameSession", () => {
  it("init() reads and caches the L1 balance", async () => {
    const chain = fakeChain({ readPlayerBalance: vi.fn(async () => 5_000_000n) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    expect(await s.init()).toBe(5_000_000n);
    expect(s.balance()).toBe(5_000_000n);
    expect(s.address()).toBe("Fake111");
  });

  it("ensureSession buys in when empty, inits the round, then delegates", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000);
    expect(chain.buyIn).toHaveBeenCalledWith(2_000_000);
    expect(chain.ensureRoundInited).toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
    expect(s.delegated()).toBe(true);
  });

  it("ensureSession is idempotent once delegated (no second buy-in/delegate)", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000);
    await s.ensureSession(2_000_000);
    expect(chain.delegate).toHaveBeenCalledTimes(1);
    expect(chain.buyIn).toHaveBeenCalledTimes(1);
  });

  it("ensureSession skips buy-in when the player already has a balance", async () => {
    const chain = fakeChain({ readPlayerBalance: vi.fn(async () => 3_000_000n) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000);
    expect(chain.buyIn).not.toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
  });

  it("open arms the crank; crankArmed() reflects success", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    const opened = await s.open(1, 2000, 1_000_000);
    expect(opened.entryHuman).toBe(60000);
    expect(chain.scheduleCrank).toHaveBeenCalled();
    expect(s.crankArmed()).toBe(true);
  });

  it("open still resolves when the crank fails to arm (degrades)", async () => {
    const chain = fakeChain({ scheduleCrank: vi.fn(async () => { throw new Error("escrow underfunded"); }) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.open(1, 2000, 1_000_000);
    expect(s.crankArmed()).toBe(false);
  });

  it("noteLeverage drives the coalesced on-chain lever once delegated", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000);
    s.noteLeverage(1000);
    await tick(); await tick();
    expect(chain.lever).toHaveBeenCalledWith(1000);
  });

  it("noteLeverage is a no-op before the session is delegated", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    s.noteLeverage(1000);
    await tick(); await tick();
    expect(chain.lever).not.toHaveBeenCalled();
  });

  it("a terminal-first background lever fires onSettled", async () => {
    const onSettled = vi.fn();
    const chain = fakeChain({
      lever: vi.fn(async () => ({ settled: true, outcome: 2, outcomeName: "liq", payout: 0n, exitRaw: 0n, exitHuman: 0, balance: 4_000_000n })),
    });
    const s = createGameSession({ mint: MINT, onSettled, injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000);
    s.noteLeverage(2000);
    await tick(); await tick();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 2, outcomeName: "liq", payout: 0n }));
  });

  it("close caches the settled balance", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    const res = await s.close();
    expect(res.payout).toBe(1_500_000n);
    expect(s.balance()).toBe(4_500_000n);
  });

  it("endSession undelegates and clears the delegated flag", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000);
    await s.endSession();
    expect(chain.commitAndUndelegate).toHaveBeenCalled();
    expect(s.delegated()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd redline3d && npx vitest run src/chain/game-session.test.ts`
Expected: FAIL — `./game-session` does not exist.

- [ ] **Step 3: Implement `game-session.ts`**

Create `redline3d/src/chain/game-session.ts`:

```ts
import { PublicKey } from "@solana/web3.js";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import { createChainRound, type ChainRound, type OpenedRound, type SettledRound, type ActionResult, type RoundSnap } from "./chain-round";
import { createLeverSync } from "./lever-sync";

/** The settled shape main.ts needs to finalize a round in the HUD. */
export type SettledInfo = { outcome: number; outcomeName: string; payout: bigint };

export interface GameSession {
  address(): string;
  delegated(): boolean;
  crankArmed(): boolean;
  balance(): bigint;
  init(): Promise<bigint>;
  refreshBalance(onEr?: boolean): Promise<bigint>;
  ensureSession(buyInBase: number): Promise<void>;
  open(dir: 1 | -1, lev: number, stakeBase: number): Promise<OpenedRound>;
  noteLeverage(lev: number): void;
  flip(dir: 1 | -1): Promise<ActionResult>;
  close(): Promise<SettledRound>;
  poll(): Promise<RoundSnap | null>;
  endSession(): Promise<void>;
  withdraw(): Promise<void>;
}

/**
 * On-chain ER-session controller wrapping chain-round + a single-flight lever sync.
 * `injectChain`/`injectAddress` are test seams; in the app they default to a dev-keypair port.
 */
export function createGameSession(opts: {
  mint: PublicKey;
  onSettled: (info: SettledInfo) => void;
  injectChain?: ChainRound;
  injectAddress?: string;
}): GameSession {
  const port = opts.injectChain ? null : createDevKeypairPort();
  let chain: ChainRound | null = opts.injectChain ?? null;
  let isDelegated = false;
  let armed = false;
  let bal = 0n;

  function need(): ChainRound {
    if (!chain) throw new Error("game_session_not_initialized");
    return chain;
  }

  // Background coalesced on-chain leverage: instant local feel lives in main.ts; this trails to latest.
  const leverSync = createLeverSync({
    send: async (lev) => {
      if (!chain) return;
      const res = await chain.lever(lev);
      if (res.settled) opts.onSettled(res);
    },
  });

  return {
    address: () => opts.injectAddress ?? port?.currentAddress() ?? "",
    delegated: () => isDelegated,
    crankArmed: () => armed,
    balance: () => bal,

    async init() {
      if (!chain) {
        await port!.connect();
        chain = createChainRound({ wallet: portToAnchorWallet(port!), mint: opts.mint });
      }
      bal = await chain.readPlayerBalance(false);
      return bal;
    },

    async refreshBalance(onEr = false) {
      bal = await need().readPlayerBalance(onEr);
      return bal;
    },

    async ensureSession(buyInBase) {
      const c = need();
      if (isDelegated) return;
      const onL1 = await c.readPlayerBalance(false);
      if (onL1 === 0n) await c.buyIn(buyInBase);
      await c.ensureRoundInited();
      await c.delegate(); // hardened: reuses a stale-but-live same-wallet session, else throws DelegateBusyError
      isDelegated = true;
      bal = await c.readPlayerBalance(true);
    },

    async open(dir, lev, stakeBase) {
      const c = need();
      const opened = await c.open(dir, lev, stakeBase);
      armed = false;
      try { await c.scheduleCrank(); armed = true; } catch { armed = false; }
      return opened;
    },

    noteLeverage(lev) {
      if (isDelegated) leverSync.submit(lev);
    },

    async flip(dir) {
      return need().flip(dir);
    },

    async close() {
      const res = await need().close();
      bal = res.balance;
      return res;
    },

    async poll() {
      return need().readRound(true);
    },

    async endSession() {
      await need().commitAndUndelegate();
      isDelegated = false;
      bal = await need().readPlayerBalance(false);
    },

    async withdraw() {
      const c = need();
      const b = await c.readPlayerBalance(false);
      await c.withdraw(Number(b));
      bal = await c.readPlayerBalance(false);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd redline3d && npx vitest run src/chain/game-session.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck the whole package**

Run: `cd redline3d && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/chain/game-session.ts redline3d/src/chain/game-session.test.ts
git commit -m "feat(chain): game-session controller (ER lifecycle + coalesced lever)"
```

---

## Task 4: wallet page — gated on-chain session footer (play balance + End + Withdraw)

**Files:**
- Modify: `redline3d/src/ui/wallet.ts`

Add ONE optional opt, `onchain`. When present, the wallet panel hides the off-chain "Add to play balance" deposit controls and renders a footer: the on-chain **play balance**, an **End session** button (enabled while delegated), and a **Withdraw to wallet** button (enabled when not delegated and the balance is positive). When `onchain` is absent (the off-chain build), the page is byte-for-byte unchanged. This is DOM-heavy UI verified in the browser step (Task 7), not a unit test.

- [ ] **Step 1: Extend `WalletOpts` with the optional on-chain hook**

In `redline3d/src/ui/wallet.ts`, add to the `WalletOpts` interface (after `onAddToPlay?` ~line 33):

```ts
  /**
   * On-chain (Slice 4) session controls. When present the panel shows a play-balance + End/Withdraw
   * footer and hides the off-chain deposit CTAs. `status()` is read on every open/refresh.
   */
  onchain?: {
    status: () => { delegated: boolean; playCents: number };
    end: () => Promise<void>;
    withdraw: () => Promise<void>;
  };
```

- [ ] **Step 2: Add footer markup to the panel**

In `createWallet`, append a footer container to the `panel.innerHTML` template — change the final line of the template (currently `` `<div id="wltAcct"></div>`; ``) to:

```ts
    `<div id="wltAcct"></div>` +
    `<div id="wltOnchain" hidden></div>`;
```

- [ ] **Step 3: Add a footer style block**

Inside `injectStyles()`, append to the `s.textContent` template literal (just before the closing `` ` ``):

```ts
    .wlt-oc{display:flex;flex-direction:column;gap:10px;padding-top:4px;border-top:1px solid rgba(132,150,224,.18)}
    .wlt-oc-row{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:11px;
      background:rgba(7,5,18,.6);border:1px solid rgba(132,150,224,.2)}
    .wlt-oc-row .lbl{flex:1;font:700 9px/1.3 'Chakra Petch',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
    .wlt-oc-row .val{font:800 16px/1 'Chakra Petch',ui-monospace,monospace;color:var(--ink);font-variant-numeric:tabular-nums}
    .wlt-oc-btns{display:flex;gap:8px}
    .wlt-oc-btn{flex:1;border:0;cursor:pointer;border-radius:9px;padding:12px 0;
      font:700 12px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;transition:.13s}
    .wlt-oc-btn.end{color:rgba(255,209,102,.92);background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.35)}
    .wlt-oc-btn.wd{color:var(--cyan);background:rgba(39,231,255,.12);border:1px solid rgba(39,231,255,.38)}
    .wlt-oc-btn:disabled{opacity:.4;cursor:not-allowed}
```

- [ ] **Step 4: Render + wire the footer; hide the off-chain CTAs when on-chain**

In `createWallet`, add a renderer and call it from `setOpen`. First add, right after the `renderAddressUI` function definition (after its closing `};` ~line 333):

```ts
  const ocEl = q<HTMLElement>("#wltOnchain");
  let ocBusy = false;
  const renderOnchain = () => {
    if (!opts.onchain) { ocEl.hidden = true; return; }
    // on-chain mode: the auto buy-in + Receive QR fund the table, so hide the off-chain deposit CTAs
    const addPlay = panel.querySelector<HTMLElement>("#wltAddPlay");
    const addNoteEl = panel.querySelector<HTMLElement>("#wltAddNote");
    if (addPlay) addPlay.style.display = "none";
    if (addNoteEl) addNoteEl.style.display = "none";
    const { delegated, playCents } = opts.onchain.status();
    ocEl.hidden = false;
    ocEl.innerHTML =
      `<div class="wlt-oc">
         <div class="wlt-oc-row"><span class="lbl">Play balance</span><span class="val">$${fmt(playCents / 100)}</span></div>
         <div class="wlt-oc-btns">
           <button class="wlt-oc-btn end" id="wltOcEnd" ${delegated ? "" : "disabled"}>End session</button>
           <button class="wlt-oc-btn wd" id="wltOcWd" ${!delegated && playCents > 0 ? "" : "disabled"}>Withdraw</button>
         </div>
       </div>`;
    const endBtn = ocEl.querySelector<HTMLButtonElement>("#wltOcEnd");
    const wdBtn = ocEl.querySelector<HTMLButtonElement>("#wltOcWd");
    const run = async (btn: HTMLButtonElement, label: string, fn: () => Promise<void>) => {
      if (ocBusy) return;
      ocBusy = true; btn.disabled = true; const prev = btn.textContent; btn.textContent = label;
      try { await fn(); } catch { /* surfaced by main's status line */ }
      finally { ocBusy = false; btn.textContent = prev ?? ""; renderOnchain(); renderBalance(); }
    };
    if (endBtn) endBtn.onclick = () => void run(endBtn, "Ending…", opts.onchain!.end);
    if (wdBtn) wdBtn.onclick = () => void run(wdBtn, "Withdrawing…", opts.onchain!.withdraw);
  };
```

Then in `setOpen`, add `renderOnchain();` inside the `if (open) { ... }` block (after `renderConnectButtons();`):

```ts
    if (open) {
      renderBalance();
      renderAddressUI();
      renderConnectButtons();
      renderOnchain();
      showTab("buy");
      void refreshBalance();
    }
```

And update the `setBalance` return method so a balance refresh also refreshes the footer:

```ts
    setBalance() { renderBalance(); renderOnchain(); },
```

- [ ] **Step 5: Typecheck**

Run: `cd redline3d && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/ui/wallet.ts
git commit -m "feat(ui): gated on-chain wallet footer (play balance + End + Withdraw)"
```

---

## Task 5: `main.ts` — the fold

**Files:**
- Modify: `redline3d/src/main.ts`

This is one coherent task: each step is an `Edit`, and the file must `tsc`-pass only at the end (Step 13). Do the edits in order. After this task there must be **zero** references to `serverMark`, `pollMark`, `dispEq`, `lastMarkMs`, `MARK_HOLD_MS`, `MarkResult`, or `roundSync` anywhere in `main.ts`.

The local `RoundEngine` drives the smooth visual × every frame (no server mark); the on-chain `Round` is the only money truth via the `readRound` terminal poll + the authoritative `close()` payout. `round.entryPx` and `engine.launch({ entryRaw })` are seeded with the on-chain **human** entry price.

- [ ] **Step 1: Imports — drop `MarkResult`/`createRoundSync`, add the chain layer**

Edit line 17:
```ts
import { createApi, type MarkResult } from "./core/api";
```
→
```ts
import { createApi } from "./core/api";
```

Edit line 22:
```ts
import { createRoundSync, clampInt } from "./core/round-sync";
```
→
```ts
import { clampInt } from "./core/round-sync";
```

Add after line 49 (the last existing import):
```ts
import { PublicKey } from "@solana/web3.js";
import { CHAIN } from "./chain/config";
import { createGameSession } from "./chain/game-session";
```

- [ ] **Step 2: Delete the `roundSync` creation**

Delete line 87 entirely:
```ts
const roundSync = createRoundSync({ api, clock: { now: () => performance.now() }, store: { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } } });
```

- [ ] **Step 3: Add the on-chain session + money helpers**

Immediately after `const engine = new RoundEngine();` (line 77), insert:

```ts
// ── on-chain round (Slice 4) ────────────────────────────────────────────────
// The round loop + USDC play balance run on-chain via the dev-keypair port. The local engine
// still drives the smooth visual ×; the on-chain Round is the only money truth.
const USDC_PER_CENT = 10 ** (CHAIN.USDC_DECIMALS - 2); // 6-decimal USDC, display in cents → 10_000
const centsToBase = (cents: number) => cents * USDC_PER_CENT;
const baseToCents = (base: bigint) => Number(base / BigInt(USDC_PER_CENT));
const BUY_IN_BASE = 2_000_000; // 2 test-USDC auto buy-in on the first GO (dev default)
let lastStakeCents = 0;
let roundActive = false; // a round is open locally (de-dupes finalizeSettled across crank/poll/close)
let settling = false;    // a close tx is in flight
let opening = false;     // the GO handler (ensureSession+open) is mid-flight
const session = createGameSession({
  mint: new PublicKey(CHAIN.TEST_USDC_MINT),
  onSettled: (info) => finalizeSettled(info), // terminal-first background lever
});
// The cash chip + wallet hero read the on-chain play balance (cents). Single writer.
function syncOnchainBalance() {
  balance = baseToCents(session.balance());
  hud.setBalance(balance);
  walletUI.setBalance(balance);
}
void session.init().then(() => syncOnchainBalance()).catch(() => {});
```

- [ ] **Step 4: Delete the server-mark machinery**

Delete lines 160-183 (the comment block + `MARK_HOLD_MS`, `serverMark`, `marking`, `lastMarkMs`, `dispEq`, and the whole `pollMark()` function).

Then in `doLogout()` delete the line:
```ts
  serverMark = null;
```

- [ ] **Step 5: Remove the server round-recover from `initSession`**

In `initSession`, delete line 296:
```ts
    if (me.openRoundId) await roundSync.recover(me.openRoundId);
```
(The round is on-chain now; the server session stays only for identity/lobby gating.)

- [ ] **Step 6: Replace `settleVia` with `finalizeSettled` + `closeRound`**

Replace the whole block from `let settling = false;` (line 474) through the end of `settleVia` (line 521) with:

```ts
// Single sink for every ending — manual cash out, terminal-first flip/lever, and the crank poll.
// Freezes the local visual, sets the HUD outcome from the on-chain settled payload, fires FX, and
// refreshes the on-chain balance. Idempotent per round via `roundActive`.
function finalizeSettled(info: { outcome: number; outcomeName: string; payout: bigint }) {
  if (!roundActive) return;
  roundActive = false;
  const price = priceSource.price(), now = Date.now();
  if (engine.getPhase() === "live") engine.cashout(price, now); // freeze the visual at the live value
  const finalEq = engine.snapshot(price, now).equity;
  const liq = info.outcome === 2; // 0 cashout · 1 cap · 2 liq · 3 time
  const payoutCents = baseToCents(info.payout);
  // reset UI
  releaseHold();
  throttle = 34; game.equity = 1; chase.setDriving(false);
  garage.setBusy(false); mapBtn.setVisible(true); upgrades.setBusy(false); walletUI.setBusy(false);
  hud.setTimer(CONFIG.MAXSEC, false);
  controls.setLive(false, "GO!");
  hud.setMultiplier(Math.max(0, liq ? 0 : finalEq), liq ? "liquidated" : "settled");
  if (liq) {
    hud.setStatus("💥 Liquidated. Lost the play amount.");
    fx.liquidate(); audio.liquidate(); navigator.vibrate?.([30, 40, 30, 40, 90]);
  } else {
    hud.setStatus(`Settled at ×${finalEq.toFixed(2)}. Banked ${usd(payoutCents)}.`);
    fx.confetti(); audio.cashout(); navigator.vibrate?.(35);
  }
  void session.refreshBalance(session.delegated()).then(() => syncOnchainBalance()).catch(() => {});
}

// Authoritative on-chain close. On a confirmed close we finalize immediately; on an RPC hiccup we
// leave the round active so the crank/poll finalizes it (idempotent vs the crank).
async function closeRound(reason: "cashout" | "expire") {
  if (settling || !roundActive) return;
  settling = true;
  releaseHold();
  controls.setLive(true, "Settling…");
  try {
    const res = await session.close();
    finalizeSettled(res);
  } catch {
    controls.setLive(true, "CASH OUT");
    hud.setStatus("Close didn't confirm — the round will settle shortly.");
    void reason;
  } finally {
    settling = false;
  }
}
```

- [ ] **Step 7: Rewrite `controls.onLaunch` (GO = auto-session + open + crank)**

Replace the entire `controls.onLaunch(async () => { ... });` block (lines 523-582) with:

```ts
controls.onLaunch(async () => {
  if (mode === "lobby") return; // Space/Enter in the lot must not launch behind the scene
  audio.resume(); radio.resume();
  if (opening || settling || roundActive || engine.getPhase() === "live") return; // re-entrancy
  opening = true;
  try {
    // First GO auto-starts the ER session (buy-in if empty + delegate).
    hud.setStatus("Starting session…");
    try {
      await session.ensureSession(BUY_IN_BASE);
    } catch (e: any) {
      hud.setStatus(e?.code === "delegate_busy" ? e.message : "Couldn't start the session. Try again.");
      return;
    }
    await session.refreshBalance(true); syncOnchainBalance();

    const playAmount = controls.playAmount(); // cents
    if (session.balance() < BigInt(centsToBase(playAmount))) {
      hud.setStatus("Add USDC to your play balance to race.");
      walletUI.open();
      return;
    }
    const dir = controls.dir();
    const lev = clampInt(game.lev, 10, 2000); // on-chain RMAX=2000
    hud.setStatus("Launching…");
    let opened;
    try {
      opened = await session.open(dir, lev, centsToBase(playAmount));
    } catch {
      hud.setStatus("Couldn't start the round. Try again.");
      controls.setLive(false, "GO!");
      return;
    }
    round.entryPx = opened.entryHuman; // human entry price (NOT the raw mantissa)
    round.dir = dir;
    lastStakeCents = playAmount;
    roundStartMs = Date.now();
    engine.launch({ dir, lev, stake: playAmount, entryRaw: opened.entryHuman, startMs: roundStartMs });
    roundActive = true;
    chase.setDriving(true);
    controls.setLive(true, "CASH OUT");
    garage.setBusy(true); mapBtn.setVisible(false); upgrades.setBusy(true); walletUI.setBusy(true);
    hud.setStatus(session.crankArmed() ? "" : "⚠ auto-settle crank not armed — cash out manually.");
  } finally {
    opening = false;
  }
});
```

- [ ] **Step 8: Rewrite `controls.onCashout`**

Replace the `controls.onCashout(() => { ... });` block (lines 584-588) with:

```ts
controls.onCashout(() => {
  if (!roundActive || settling) return;
  void closeRound("cashout");
});
```

- [ ] **Step 9: Frame loop — leverage to the on-chain session, RMAX 2000, drop `roundSync.pump`**

Edit line 654:
```ts
  game.lev = clampInt(niceLev(tToLev(throttle)) * boost, 10, 1000); // parity: never exceed server RMAX
```
→
```ts
  game.lev = clampInt(niceLev(tToLev(throttle)) * boost, 10, 2000); // on-chain RMAX=2000
```

Edit line 657:
```ts
  if (drivable) { engine.setLeverage(game.lev, roundPrice); roundSync.noteLeverage(game.lev); }
  roundSync.pump();
```
→
```ts
  if (drivable) { engine.setLeverage(game.lev, roundPrice); session.noteLeverage(game.lev); } // instant local + coalesced on-chain
```

- [ ] **Step 10: Frame loop — drive the live × from the local engine; time-cap backstop closes on-chain**

Replace the live branch (lines 660-685, from `if (engine.getPhase() === "live") {` through the `else` that begins the idle branch — keep the existing idle `else { car.setEquity("idle", 1); hud.setTimer(CONFIG.MAXSEC, false); }`) with:

```ts
  if (engine.getPhase() === "live") {
    const nowMs = Date.now();
    // The smooth ×, payout and liq-buffer are the LOCAL engine off the live feed (no server mark).
    // The on-chain Round is the money truth — surfaced by the crank poll + the authoritative close().
    const snap = engine.snapshot(roundPrice, nowMs);
    game.equity = snap.equity;
    hud.setMultiplier(Math.max(0, snap.equity), "live");
    controls.setBuffer(Math.max(0, Math.min(1, snap.buffer)));
    hud.setTimer(CONFIG.MAXSEC - (nowMs - roundStartMs) / 1000, true);
    car.setEquity("live", Math.max(0, snap.equity));
    const payC = Math.floor(snap.payout);
    controls.setLive(true, `${snap.equity >= 1 ? "CASH OUT" : "BAIL"} ${usd(payC)}`, snap.equity < 1);
    // Local 60s backstop: the native crank normally settles first; this closes on-chain if it lags.
    if (roundActive && !settling && (nowMs - roundStartMs) / 1000 >= CONFIG.MAXSEC) void closeRound("expire");
  } else {
    car.setEquity("idle", 1);
    hud.setTimer(CONFIG.MAXSEC, false);
  }
```

- [ ] **Step 11: Lane-bet flip → background on-chain `flip`**

Replace the lane-bet block (lines 697-708, the `if (ability === "laneBet") { ... }` body) with:

```ts
    if (ability === "laneBet") {
      const laneDir: 0 | 1 | -1 = carXTarget < -0.6 ? 1 : carXTarget > 0.6 ? -1 : 0;
      if (laneDir !== 0) {
        if (laneDir !== round.dir && !flipping) {
          engine.setDir(laneDir, roundPrice);    // instant local flip (feel)
          round.dir = laneDir;
          round.entryPx = roundPrice;             // re-anchor the local liq line
          void doFlip(laneDir);                   // mirror to the on-chain round in the background
        }
        controls.setDir(laneDir);
      }
    }
```

Then add the `flipping` flag + `doFlip` helper. Insert just above `function frame() {` (line 590):

```ts
// Lane-bet flips fire an on-chain flip() in the background (instant local feel above). A terminal-first
// flip settles the round via finalizeSettled; single-flight via `flipping` so a held lane can't spam txs.
let flipping = false;
async function doFlip(dir: 1 | -1) {
  if (flipping || !roundActive) return;
  flipping = true;
  try {
    const res = await session.flip(dir);
    if (res.settled) finalizeSettled(res);
  } catch {
    /* keep playing; the local flip already applied and close() settles at on-chain truth */
  } finally {
    flipping = false;
  }
}
```

- [ ] **Step 12: Add the crank terminal poll + wire the wallet on-chain footer**

Insert just before `requestAnimationFrame(frame);` (line 761):

```ts
// Poll the on-chain Round ~1.5×/s so a crank/keeper settlement surfaces even if the player never taps.
// setInterval (not rAF) because rAF is throttled hard in Claude Preview.
let polling = false;
setInterval(async () => {
  if (!roundActive || settling || polling || !session.delegated()) return;
  polling = true;
  try {
    const snap = await session.poll();
    if (snap && snap.status === 2) finalizeSettled(snap);
  } catch { /* transient RPC — keep last */ }
  finally { polling = false; }
}, 650);
```

Then wire End/Withdraw into the existing `createWallet({...})` call. Add an `onchain` property to its opts object (inside the `const walletUI = createWallet(hudRoot, { ... })` literal, after the `onAddToPlay` handler):

```ts
  onchain: {
    status: () => ({ delegated: session.delegated(), playCents: baseToCents(session.balance()) }),
    end: async () => {
      hud.setStatus("Ending session…");
      await session.endSession();
      syncOnchainBalance();
      hud.setStatus("Session ended. Withdraw to your wallet, or press GO to start a new one.");
    },
    withdraw: async () => {
      hud.setStatus("Withdrawing…");
      await session.withdraw();
      syncOnchainBalance();
      hud.setStatus("Withdrew your play balance to the wallet.");
    },
  },
```

- [ ] **Step 13: Typecheck the fold**

Run: `cd redline3d && npx tsc --noEmit`
Expected: no errors. If `tsc` reports a leftover `serverMark`/`roundSync`/`dispEq`/`MarkResult` reference, fix it before committing (grep: `grep -nE "serverMark|roundSync|dispEq|lastMarkMs|MARK_HOLD_MS|MarkResult" src/main.ts` must return nothing).

- [ ] **Step 14: Run the full unit suite (no regressions)**

Run: `cd redline3d && npm test`
Expected: PASS — all existing tests plus the new `chain-round`, `lever-sync`, `game-session` tests. (The gated `chain-round.devnet.test.ts` is skipped without `RAIDER_DEVNET=1`.)

- [ ] **Step 15: Commit**

```bash
git add redline3d/src/main.ts
git commit -m "feat(game): fold on-chain round loop into the 3D game (main.ts)"
```

---

## Task 6: Devnet integration — delegate-busy + reuse paths

**Files:**
- Modify: `redline3d/src/chain/chain-round.devnet.test.ts`

The coalesced-lever collapse is already proven deterministically in Task 2's unit tests. This gated test covers the on-chain delegate states that can't be unit-tested: a second wallet on the same shared house gets a typed `delegate_busy`, and the same wallet re-delegating returns clean (reuse).

- [ ] **Step 1: Add the gated integration test**

Append a new `it` inside the existing `describe.skipIf(!RUN)("chain-round devnet loop", () => { ... })` block in `redline3d/src/chain/chain-round.devnet.test.ts` (it already imports `createDevKeypairPort`, `portToAnchorWallet`, `createChainRound`, anchor, web3, spl-token, `readFileSync`, `idl`):

```ts
  it("delegate() reuses our own live session and rejects a foreign wallet on the shared house", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // fresh mint + funded house shared by both players
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse().accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });

    // two independent dev-keypair players on the same mint
    const mkPlayer = async () => {
      const kp = Keypair.generate();
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
      const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mint, kp.publicKey);
      await mintTo(conn, funder, mint, ata.address, funder.publicKey, 5_000_000);
      const port = createDevKeypairPort({ secretKey: kp.secretKey, store: { get: () => null, set: () => {} } });
      await port.connect();
      return createChainRound({ wallet: portToAnchorWallet(port), mint });
    };
    const a = await mkPlayer();
    const b = await mkPlayer();

    // A takes the house
    await a.buyIn(5_000_000);
    await a.ensureRoundInited();
    await a.delegate();

    // A re-delegating is a clean reuse (no throw)
    await expect(a.delegate()).resolves.toBeUndefined();

    // B can't delegate against the held shared house — typed busy, not a raw revert
    await b.buyIn(5_000_000);
    await b.ensureRoundInited();
    await expect(b.delegate()).rejects.toMatchObject({ code: "delegate_busy" });

    // cleanup: A brings the house home so the shared PDA is free for the next run
    await a.commitAndUndelegate();
  }, 240_000);
```

- [ ] **Step 2: Run the gated integration test**

Run: `cd redline3d && RAIDER_DEVNET=1 ANCHOR_WALLET=$HOME/.config/solana/lazer-probe.json npx vitest run --config vitest.config.devnet.ts -t "rejects a foreign wallet"`
Expected: PASS. (Requires the funded operator keypair at `~/.config/solana/lazer-probe.json` and devnet + the ER validator reachable. Real on-chain test — allow up to ~4 min.)

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/chain/chain-round.devnet.test.ts
git commit -m "test(chain): devnet delegate reuse + foreign-wallet busy on the shared house"
```

---

## Task 7: Browser verification — the real game on devnet (Claude Preview)

**Files:** none (verification only). Per the verify-in-browser rule, the fold is not "done" until the **real game** (`index.html`) plays an on-chain round in the browser.

- [ ] **Step 1: Start the dev server + open the game**

Use `preview_start` on `redline3d` (`npm run dev`), then open the root URL (`/` → `index.html`, which loads `src/main.ts`). Confirm the console logs `redline3d render up` with no chain import errors.

- [ ] **Step 2: Read the dev wallet address + fund it**

Read the dev-keypair address: `preview_eval` →
```js
JSON.parse(localStorage.getItem("redline.chain.devkey.v1") ? "true" : "false");
// then read the on-page address: the wallet chip / or eval the session address
```
Get the address from the cash/wallet chip (open the wallet panel) or by evaluating the port address. Then fund it from the repo root:
```bash
node redline3d/scripts/fund-wallet.mjs <ADDRESS> 8tZXkKuat9KoisUjFkq4kBUa1p746Mn4tj4i3st5Th1Y
```
Expected: 0.1 SOL (if low) + 10 test-USDC transferred. Reload the preview.

- [ ] **Step 2.5: Operational guard — free the shared house first**

The HouseBalance PDA is shared per-mint and hosts one session at a time. If a previous Preview/browser session was left delegated, the first GO will throw `delegate_busy`. If so, End that prior session (or run a one-shot `commit_and_undelegate` with its key) before proceeding. After this slice, **always use the wallet panel's "End session"** when finishing.

- [ ] **Step 3: Drive a full manual round**

Pick the **Clown Car** in the Garage (lane-bet ability). Press **GO**:
- Verify the status line shows "Starting session…" → "Launching…" → "" (crank armed) and the car goes live.
- Drive: hold the road, sweep the throttle up and confirm the × responds instantly and the tach needle climbs to high leverage (up to 2000×).
- Steer across center to flip lanes (LONG↔SHORT) and confirm the call box readout flips.
- Tap **CASH OUT** and confirm a settled badge + the cash chip updates to the on-chain payout.

Use `preview_snapshot` between actions to read HUD state (rAF is throttled in Preview — drive via DOM/state reads, not by waiting for live animation). Use `preview_console_logs` / `preview_network` to confirm ER txs (open/lever/flip/close) and no uncaught errors.

- [ ] **Step 4: Verify a hands-off crank settlement**

Press GO to open a fresh round, then **do not touch it**. Within ~60s the native crank must settle it (TIME/cap/liq) with zero client close — confirm the `setInterval` poll flips the HUD to a settled/liquidated badge and the cash chip refreshes. (Poll loop reads `session.poll()` → `status === 2` → `finalizeSettled`.)

- [ ] **Step 5: Verify End session + Withdraw**

Open the wallet panel (tap the cash chip). Confirm the on-chain footer shows the play balance, **End session** (enabled while delegated), **Withdraw** (enabled after End). Click **End session** → status "Session ended…"; then **Withdraw** → status "Withdrew…", play balance → $0.00, and the test-USDC returns to the wallet ATA.

- [ ] **Step 6: Capture proof**

Take a `preview_screenshot` of (a) a live round at high leverage and (b) a settled badge. Share both with the user as the verification artifact.

- [ ] **Step 7: Stop the preview**

`preview_stop`.

---

## Self-Review

**1. Spec coverage** (against `2026-06-29-client-slice4-game-fold-design.md`):
- "route open/flip/lever/close + USDC play balance through chain-round" → Task 3 (controller) + Task 5 (main.ts wiring). ✅
- "auto-start ER session on first GO; explicit End/Withdraw" → Task 5 Step 7 (`ensureSession` on GO) + Task 4 + Task 5 Step 12 (wallet footer). ✅
- "crank poll + finalizeSettled sink in the 3D HUD" → Task 5 Steps 6, 12. ✅
- "throttle→leverage on-chain with instant local feel" (coalesce-to-latest) → Task 2 + Task 3 `noteLeverage` + Task 5 Step 9. ✅
- "delegate() already-delegated hardening (auto-recover / clear error)" → Task 1. ✅
- "delete serverMark machinery; swap auth/balance source; retire roundSync" → Task 5 Steps 1, 2, 4, 5, and the rewrites. ✅
- "entryHuman (not raw) seeds the engine" → Task 5 Step 7. ✅
- "crank-first; 60s local timeout idempotent fallback" → Task 5 Step 10 (`closeRound("expire")` guarded by `roundActive`/`settling`). ✅
- "soft-coin economy untouched; RMAX=2000 untouched" → no edits to `ui/upgrades.ts`/`ui/coins.ts`; both clamp sites moved to 2000. ✅
- "keep onchain.html as the debug entry" → not modified. ✅
- Testing: gated devnet integration (Task 6) + Claude Preview on `index.html` (Task 7). ✅

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step shows complete code; every run step shows the exact command + expected result. ✅

**3. Type consistency:**
- `SettledInfo` `{ outcome; outcomeName; payout }` is a structural subset of `SettledRound`/`RoundSnap`, so `session.close()` (returns `SettledRound`), `session.poll()` (returns `RoundSnap`), and the terminal-first `flip`/`lever` (`ActionResult` settled branch) all satisfy `finalizeSettled(info)` and `onSettled`. ✅
- `createGameSession` is called once in `main.ts` (Task 5 Step 3) with `{ mint, onSettled }`; the `injectChain`/`injectAddress` seams are test-only (Task 3). ✅
- `centsToBase`/`baseToCents`/`BUY_IN_BASE`/`USDC_PER_CENT`/`lastStakeCents`/`roundActive`/`settling`/`opening`/`flipping`/`polling` are all declared in `main.ts` before use (Step 3 adds the money block near line 77; `flipping` in Step 11; `polling` in Step 12). ✅
- `finalizeSettled` and `closeRound` are function declarations (hoisted), so the `session` `onSettled` closure (Step 3) referencing `finalizeSettled` resolves. ✅
- `clampInt` still imported from `core/round-sync` (Step 1 keeps it). ✅

**Known dev-scope rough edges (intentional, per spec scope):** the wallet panel's off-chain "Fund"/deposit CTAs are hidden (not deleted) when the `onchain` prop is present; the off-chain `serverBalance`/wallet-binding/deposit helpers remain in `main.ts` for the server identity/lobby path but no longer drive the cash chip. Putting the soft-coin economy on-chain and removing the dead off-chain funding path are tracked as later slices.
