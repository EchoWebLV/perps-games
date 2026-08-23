# Paddock Privy Direct Betting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Privy-signed-in player bets on the live paddock race book straight from their wallet — no funding screen, no buy-in chips, the chain seat staged invisibly ahead of need, exactly like the perps.

**Architecture:** Copy raider's `ensureSession` model (game-session.ts): the player thinks in "my SOL"; a staging controller quietly moves a 5-bet buffer from the Privy wallet into the delegated `Bettor` the moment the player enters the race (never on a BET tap — the 15s market won't wait), refills in the background when the balance runs short, and the BET tap itself is always one instant ER send. `main.ts` builds the chain book for any connected wallet via the existing `session.anchorWallet()` seam; guests keep the local sim byte-for-byte.

**Tech Stack:** TypeScript, vitest, @coral-xyz/anchor, existing paddock client (`chain/paddock.ts`), MagicBlock ER devnet. **No Rust changes, no redeploy.**

**User decisions honored (2026-07-28):** no funding chips/screen ("no chips, direct betting"); model copied from the perps; stake chips $1/$5/$20 stay as the bet-size selector (they are the analog of the perps' bet stepper, and the user approved them in the original design).

**Known facts this plan builds on (verified, do not re-derive):**
- `place_bet` auto-settles a PAST ticket before checking balance — a $5 bet landed live with $3.00 balance + $4.75 claimable (race 602→606 session, 2026-07-28). So *betable = balance + claimable*.
- A delegated `Bettor` cannot be topped up on L1; the only refill is claim/exit → deposit → re-delegate (`cashOut` + `ensureBettor`, both proven on devnet).
- `cashOut` throws `LiveStakesError` while the ticket rides the live race — a refill attempt mid-race must quietly retry later, not error.
- `race-book-source.ts:503` drops a tap outside `PHASE_MARKET` — keep that guard.
- The scheduled crank is NOT durable (died twice in 24h). Before any live demo, re-run `onchain/raider/scripts/paddock-house-setup.mjs` (idempotent, free).

---

## File Structure

| File | Role |
|---|---|
| `redline3d/src/chain/paddock.ts` (modify) | Client additions: `walletFunds()`, fast-poll `placeBet` send, corrected MarketClosed copy |
| `redline3d/src/chain/paddock-staging.ts` (create) | The staging controller — raider's `ensureSession` adapted to paddock (buffer, fail-fast, silent refill, single-flight) |
| `redline3d/src/chain/paddock-staging.test.ts` (create) | Controller state machine tests with a fake client |
| `redline3d/src/render/race-book-source.ts` (modify) | `staging` option replaces `onboard`; `placeBet` = pure send; `betable()`; `ensureFunded()`; onboarding view mapped from staging status |
| `redline3d/src/render/race-book-source.test.ts` (modify) | Rewire chain-book tests to the staging seam |
| `redline3d/src/ui/bet-panel.ts` (modify) | Gate BET on `betable`; one-number wallet display; setup vs top-up notes; `selectedStake()` getter; export `DEFAULT_STAKE` |
| `redline3d/src/ui/bet-panel.test.ts` (modify) | Gate + note tests |
| `redline3d/src/render/race-mode.ts` (modify) | Thread `betable` into ctx; call `ensureFunded(selectedStake)` in the frame loop |
| `redline3d/src/main.ts` (modify) | Lazy per-address paddock client+staging; async chain-book build in `enterGrandprix`; paddock leg in wallet-panel `cashOut` |

Existing patterns to follow: BN-free snapshots, HTTP-poll sends, CAR-indexed arrays only across the book seam (SLOT ≠ CAR), display units via `core/stake-currency` (100 display units = 1 SOL).

---

### Task 1: Paddock client — `walletFunds()`, fast bet poll, honest market-closed copy

**Files:**
- Modify: `redline3d/src/chain/paddock.ts`
- Test: run existing `redline3d/src/chain/paddock.test.ts` (pure-function suite must stay green; copy assertions may need updating)

- [ ] **Step 1: Add `walletFunds` to the `PaddockBook` interface** (after `delegationState()`, ~line 242):

```ts
  /** The owner wallet's L1 spendables: native SOL (the thing a wSOL deposit wraps) and the
   *  owner ATA's token balance (what a non-wSOL mint would deposit). Same shape as
   *  chain-round's walletFunds so staging code reads identically across the two programs. */
  walletFunds(): Promise<{ sol: bigint; stake: bigint }>;
```

- [ ] **Step 2: Implement it in `createPaddockBook`** (next to `delegationState`, ~line 305):

```ts
  async function walletFunds(): Promise<{ sol: bigint; stake: bigint }> {
    const [sol, ata] = await Promise.all([
      baseConn.getBalance(owner),
      baseConn.getTokenAccountBalance(ownerAta).catch(() => null),
    ]);
    return { sol: BigInt(sol), stake: BigInt(ata?.value.amount ?? "0") };
  }
```

and add `walletFunds,` to the returned object (next to `delegationState,`).

- [ ] **Step 3: Give `send()` a poll interval and use it for bets.** Change the signature (~line 268):

```ts
  async function send(conn: Connection, builder: { transaction(): Promise<Transaction> }, cuLimit?: number, pollMs = 1000): Promise<string> {
```

and the loop (same 60s budget, denser polls):

```ts
    const tries = Math.ceil(60_000 / pollMs);
    for (let i = 0; i < tries; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        if (st.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
        return sig;
      }
      await sleep(pollMs);
    }
```

In `placeBet`, pass the fast interval (the ER commits in well under a second; a 1000ms poll wastes most of the market window's feel):

```ts
        await send(erConn, programER.methods.placeBet(carId, new BN(amount.toString())).accountsPartial({
          payer: owner, mint, race: pdas.race, bettor: pdas.bettor, ticket: pdas.ticket,
        }), undefined, 150);
```

- [ ] **Step 4: Correct the market-closed copy** (line ~410). The next market opens after RACING (40s) + SETTLED (6s):

```ts
        if (name === "WrongPhase") throw new MarketClosedError("Betting just closed for this race — the next market opens in about 46 seconds.");
```

- [ ] **Step 5: Run the client test suite**

Run: `cd redline3d && npx vitest run src/chain/paddock.test.ts`
Expected: PASS. If a test asserts the old "seconds away" copy, update that assertion to the new string.

- [ ] **Step 6: Typecheck and commit**

```bash
cd redline3d && npx tsc --noEmit
git add src/chain/paddock.ts src/chain/paddock.test.ts
git commit -m "paddock client: walletFunds, 150ms bet confirm poll, honest market-closed copy"
```

---

### Task 2: Staging controller — `chain/paddock-staging.ts`

The paddock analog of `game-session.ensureSession` (game-session.ts:273): stage a buffer of bets ahead of need, fail fast on an unfunded wallet, refill silently, never expose a funding concept.

**Files:**
- Create: `redline3d/src/chain/paddock-staging.ts`
- Create: `redline3d/src/chain/paddock-staging.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// paddock-staging.test.ts
import { describe, expect, it, vi } from "vitest";
import { createPaddockStaging, STAKE_BUFFER_BETS, FEE_FLOOR_LAMPORTS } from "./paddock-staging";
import { LiveStakesError } from "./paddock";
import type { RaceSnap, BettorSnap } from "./paddock";

const raceSnap = (over: Partial<RaceSnap> = {}): RaceSnap => ({
  mint: "m", seq: 10n, phase: 1, phaseEndsTs: 0,
  entrants: [0, 1, 2, 3, 4, 5, 6, 7], strengths: [], pools: [], total: 0n,
  order: [], seed: new Uint8Array(32), feed: "f", rakeAccrued: 0n,
  history: [], ...over,
});
const bettorSnap = (balance: bigint, over: Partial<BettorSnap> = {}): BettorSnap => ({
  balance, stakes: new Array(8).fill(0n), raceSeq: null, ...over,
});

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    delegationState: vi.fn(async () => "fresh" as const),
    bettorSnapshot: vi.fn(async () => null as BettorSnap | null),
    raceSnapshot: vi.fn(async () => raceSnap()),
    walletFunds: vi.fn(async () => ({ sol: 1_000_000_000n, stake: 0n })),
    ensureBettor: vi.fn(async () => {}),
    cashOut: vi.fn(async () => 0n),
    ...over,
  };
}

const STAKE = 50_000_000n; // $5

describe("createPaddockStaging", () => {
  it("fresh wallet: stages a 5-bet buffer, capped by wallet minus the fee floor", async () => {
    const client = fakeClient();
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.ensureBettor).toHaveBeenCalledTimes(1);
    expect(client.ensureBettor.mock.calls[0][0]).toBe(STAKE * BigInt(STAKE_BUFFER_BETS)); // 0.25 SOL fits under 1 SOL - floor
    expect(s.status().state).toBe("ready");
  });

  it("caps the buffer at what the wallet can spare", async () => {
    const client = fakeClient({ walletFunds: vi.fn(async () => ({ sol: STAKE + FEE_FLOOR_LAMPORTS + 1_000_000n, stake: 0n })) });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.ensureBettor.mock.calls[0][0]).toBe(STAKE + 1_000_000n);
  });

  it("fails fast on an unfunded wallet without spending anything", async () => {
    const client = fakeClient({ walletFunds: vi.fn(async () => ({ sol: 1_000_000n, stake: 0n })) });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.ensureBettor).not.toHaveBeenCalled();
    expect(s.status().state).toBe("error");
    expect(s.status().error).toMatch(/needs SOL/i);
  });

  it("delegated with a covering balance: ready, no sends", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(STAKE)),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.ensureBettor).not.toHaveBeenCalled();
    expect(client.cashOut).not.toHaveBeenCalled();
    expect(s.status().state).toBe("ready");
    expect(s.betableBase()).toBe(STAKE);
  });

  it("counts a claimable past win as betable (place_bet auto-settles it)", async () => {
    // ticket rode race 5, slot 2 won at x1.9; stakes[2] = $5 → claimable 9_500_000 * 10
    const history = new Array(32).fill({ seq: 0n, winner: 0, multFp: 0n });
    history[5] = { seq: 5n, winner: 2, multFp: 1_900_000n };
    const stakes = new Array(8).fill(0n); stakes[2] = STAKE;
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(0n, { raceSeq: 5n, stakes })),
      raceSnapshot: vi.fn(async () => raceSnap({ seq: 10n, history })),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.cashOut).not.toHaveBeenCalled(); // claimable covers the stake — no rebuild
    expect(s.status().state).toBe("ready");
    expect(s.betableBase()).toBe((STAKE * 1_900_000n) / 1_000_000n);
  });

  it("delegated and short with nothing to claim: silent rebuild (cashOut then re-stage)", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(1_000_000n)),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.cashOut).toHaveBeenCalledTimes(1);
    expect(client.ensureBettor).toHaveBeenCalledTimes(1);
    expect(s.status().state).toBe("ready");
  });

  it("a refill blocked by live stakes retries quietly — no error state", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(0n)),
      cashOut: vi.fn(async () => { throw new LiveStakesError("riding"); }),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(s.status().state).toBe("idle");
    expect(s.status().error).toBeNull();
  });

  it("is single-flight: concurrent ensure() runs once", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });
    const client = fakeClient({ ensureBettor: vi.fn(async () => gate) });
    const s = createPaddockStaging({ client });
    const a = s.ensureNow(STAKE);
    const b = s.ensureNow(STAKE);
    resolve();
    await Promise.all([a, b]);
    expect(client.ensureBettor).toHaveBeenCalledTimes(1);
  });

  it("throttles repeat attempts (min interval) so a frame-loop trigger cannot hammer RPC", async () => {
    const client = fakeClient({ walletFunds: vi.fn(async () => ({ sol: 0n, stake: 0n })) });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    await s.ensureNow(STAKE); // immediately again
    expect(client.delegationState).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd redline3d && npx vitest run src/chain/paddock-staging.test.ts`
Expected: FAIL — module `./paddock-staging` does not exist.

- [ ] **Step 3: Implement the controller**

```ts
// paddock-staging.ts — stage the paddock seat AHEAD of the tap, the way raider stages a
// session on GO (game-session.ts ensureSession): the player thinks in "my SOL"; this moves a
// buffer of bets from the wallet into the delegated Bettor, refills silently when it runs
// short, and never exposes a funding concept. The one paddock difference from raider: the
// market will not wait for a slow build the way a perps round does, so this is fired on
// race ENTRY and on balance-short — never from a BET tap.
import {
  LiveStakesError, settleTicket,
  type BettorSnap, type CashOutStep, type OnboardStep, type PaddockBook, type RaceSnap,
} from "./paddock";

/** Buffer, in bets: stage several bets' worth per crossing so the heavy refill round trip
 *  (claim/exit → undelegate → deposit → re-delegate, ~2 race cycles) stays rare. Same
 *  number, same reasoning as game-session's SESSION_BUFFER_BETS. */
export const STAKE_BUFFER_BETS = 5;
/** Fees + ATA-rent headroom left in the wallet (lamports) — game-session's FEE_FLOOR. */
export const FEE_FLOOR_LAMPORTS = 5_000_000n;
/** Quiet-retry spacing. A blocked refill (live stakes) or a failed RPC retries no faster
 *  than this, so the frame-loop trigger costs a timestamp compare, not a request. */
export const RETRY_GAP_MS = 5_000;

export type StageStep = OnboardStep | CashOutStep;

export interface StageStatus {
  /** idle → staging (first build) / refilling (rebuild) → ready; error only for states the
   *  player must act on (an unfunded wallet). A refill blocked by live stakes goes back to
   *  idle and retries — that is normal play, not news. */
  state: "idle" | "staging" | "refilling" | "ready" | "error";
  step: StageStep | null;
  error: string | null;
}

export interface PaddockStaging {
  status(): StageStatus;
  /** Last-known spendable-in-one-bet base units: delegated balance + a past ticket's
   *  claimable winnings (place_bet auto-settles those before its balance check — proven
   *  live with $3 balance + $4.75 claimable funding a $5 bet, 2026-07-28). */
  betableBase(): bigint;
  /** Last-known L1 native SOL (lamports) — the rest of the "one number" the panel shows. */
  walletSolBase(): bigint;
  /** Fire-and-forget trigger. Cheap when already ready/inflight/throttled. The caller that
   *  polls the chain anyway (the book source) passes what it just read as
   *  `observedBetableBase` — the controller's own cache only updates when a staging run
   *  executes, so without the observation a drained balance would short-circuit "ready"
   *  forever and the silent refill would never fire (found by spec review, 2026-07-28). */
  ensure(stakeBase: bigint, observedBetableBase?: bigint): void;
  /** Awaitable variant — main.ts entry kick and tests. Never rejects; failures land in status(). */
  ensureNow(stakeBase: bigint, observedBetableBase?: bigint): Promise<void>;
  dispose(): void;
}

type StagingClient = Pick<PaddockBook,
  "delegationState" | "bettorSnapshot" | "raceSnapshot" | "walletFunds" | "ensureBettor" | "cashOut">;

const messageOf = (e: unknown): string => String((e as Error)?.message ?? e);

/** balance + claimable-from-a-past-race, off the two snapshots. */
export function betableOf(race: RaceSnap | null, bettor: BettorSnap | null): bigint {
  if (!bettor) return 0n;
  const claimable = race && bettor.raceSeq !== null && bettor.raceSeq !== race.seq
    ? settleTicket(race.history, bettor)
    : 0n;
  return bettor.balance + claimable;
}

export function createPaddockStaging(deps: { client: StagingClient; onChange?: () => void }): PaddockStaging {
  const { client } = deps;
  let stat: StageStatus = { state: "idle", step: null, error: null };
  let betable = 0n;
  let walletSol = 0n;
  let inflight: Promise<void> | null = null;
  let lastAttempt = 0;
  let disposed = false;

  const set = (next: Partial<StageStatus>) => {
    stat = { ...stat, ...next };
    deps.onChange?.();
  };

  async function readBetable(): Promise<bigint> {
    const [race, bettor] = await Promise.all([
      client.raceSnapshot().catch(() => null),
      client.bettorSnapshot().catch(() => null),
    ]);
    betable = betableOf(race, bettor);
    return betable;
  }

  async function run(stakeBase: bigint): Promise<void> {
    const state = await client.delegationState();

    if (state === "reuse") {
      if (await readBetable() >= stakeBase) { set({ state: "ready", step: null, error: null }); return; }
      // Short, and nothing claimable covers it → the silent rebuild: the full way out, then a
      // fresh buffer back in. cashOut claims any past win on the way (classifyExit "claim"),
      // exits, polls the undelegation home, withdraws + unwraps — so ensureBettor below sees a
      // fresh wallet-funded state. Blocked while stakes ride the LIVE race: quietly retry later.
      set({ state: "refilling", error: null });
      try {
        await client.cashOut((s) => set({ step: s }));
      } catch (e) {
        if (e instanceof LiveStakesError) { set({ state: "idle", step: null, error: null }); return; }
        throw e;
      }
    } else if (state === "busy") {
      // Torn pair: exit is the only reuniting instruction, and cashOut routes "busy" down it.
      set({ state: "refilling", error: null });
      await client.cashOut((s) => set({ step: s }));
    }

    // Fresh (or just-rebuilt): fail fast BEFORE spending — sends go out skipPreflight, so a
    // 0-SOL Privy embedded wallet otherwise dies as a silent drop + a long confirm hang.
    const funds = await client.walletFunds();
    walletSol = funds.sol;
    if (funds.sol < stakeBase + FEE_FLOOR_LAMPORTS) {
      set({ state: "error", step: null, error: "Your wallet needs SOL first — open the wallet panel and send SOL to your address." });
      return;
    }
    // Stage a buffer of bets, capped by what the wallet can spare — their money throughout,
    // withdrawable via cash-out. Same sizing as game-session.ensureSession.
    const spendable = funds.sol - FEE_FLOOR_LAMPORTS;
    const want = stakeBase * BigInt(STAKE_BUFFER_BETS);
    const topUp = want > spendable ? spendable : want;
    set({ state: stat.state === "refilling" ? "refilling" : "staging", error: null });
    await client.ensureBettor(topUp, (s) => set({ step: s }));
    await readBetable();
    walletSol = (await client.walletFunds().catch(() => ({ sol: walletSol, stake: 0n }))).sol;
    set({ state: "ready", step: null, error: null });
  }

  async function ensureNow(stakeBase: bigint): Promise<void> {
    if (disposed) return;
    if (inflight) return inflight;
    if (stat.state === "ready" && betable >= stakeBase) return;
    const now = Date.now();
    if (now - lastAttempt < RETRY_GAP_MS) return;
    lastAttempt = now;
    if (stat.state !== "refilling") set({ state: stat.state === "ready" ? "refilling" : "staging", error: null });
    inflight = run(stakeBase)
      .catch((e) => { set({ state: "error", step: null, error: messageOf(e) }); })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return {
    status: () => stat,
    betableBase: () => betable,
    walletSolBase: () => walletSol,
    ensure: (stakeBase) => { void ensureNow(stakeBase); },
    ensureNow,
    dispose() { disposed = true; },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd redline3d && npx vitest run src/chain/paddock-staging.test.ts`
Expected: PASS (9 tests). If the "ready" pre-check test interferes with the throttle test, note `ensureNow` orders its guards: inflight → ready-and-covered → throttle.

- [ ] **Step 5: Typecheck and commit**

```bash
cd redline3d && npx tsc --noEmit
git add src/chain/paddock-staging.ts src/chain/paddock-staging.test.ts
git commit -m "paddock staging: perps-style invisible buffer — stage on entry, refill in background, never on the tap"
```

---

### Task 3: `race-book-source.ts` — staging replaces tap-onboarding

**Files:**
- Modify: `redline3d/src/render/race-book-source.ts`
- Modify: `redline3d/src/render/race-book-source.test.ts`

- [ ] **Step 1: Update the chain-book tests.** Find the existing tests that drive `placeBet` through the `onboard` option (search `onboard` in race-book-source.test.ts) and replace them with the staging seam. New/changed assertions:

```ts
// A funded bet is ONE client.placeBet call — no onboarding step ever runs from a tap.
it("placeBet sends exactly one ER transaction and nothing else", async () => { /* build source with staging: fakeStaging(); tap during MARKET; assert client.placeBet called once, staging.ensure NOT called by the tap */ });

// betable() = balance + claimable, in display units.
it("betable counts a past ticket's claimable win", async () => { /* bettor balance 0, claimable $4.75 → betable() === 4.75 */ });

// ensureFunded forwards to staging with base units.
it("ensureFunded triggers staging.ensure with the stake in base units", () => { /* src.ensureFunded(5) → staging.ensure(50_000_000n) */ });

// onboarding() mirrors staging status for the panel.
it("onboarding view maps staging status", () => { /* staging.status: staging/deposit → {kind:"setup", step:"deposit", index:3, of:5}; refilling/exit → {kind:"refill", ...} */ });
```

Use a `fakeStaging()` helper:

```ts
const fakeStaging = (over: Partial<StageStatus> = {}) => {
  const status: StageStatus = { state: "idle", step: null, error: null, ...over };
  return {
    status: () => status,
    betableBase: () => 0n,
    walletSolBase: () => 0n,
    ensure: vi.fn(),
    ensureNow: vi.fn(async () => {}),
    dispose: () => {},
  };
};
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd redline3d && npx vitest run src/render/race-book-source.test.ts`
Expected: FAIL — `staging` option and `betable`/`ensureFunded` don't exist yet.

- [ ] **Step 3: Widen `BookOnboarding` and the interface.** In race-book-source.ts:

Replace the `BookOnboarding` type (line ~51):

```ts
/** The chain plumbing running behind the scenes, expressed as progress. Two kinds:
 *  "setup" — the one-time seat build on first arrival; "refill" — the background top-up
 *  after the balance ran short. Either way the player's only verb is BET; this is the line
 *  that explains why BET is briefly unavailable, never a flow they drive. */
export interface BookOnboarding {
  kind: "setup" | "refill";
  /** True while the controller is actively moving the seat (state staging/refilling) — even
   *  between steps. The BET gate keys on THIS, not on `step`: the stepless instants inside a
   *  run are exactly when a send would hit a torn pair (quality-review finding, 2026-07-28). */
  working: boolean;
  step: StageStep | null;
  index: number;   // 1-based position in the kind's own sequence; 0 when between steps
  of: number;
  /** The STAGING pipeline's own error (actionable: "needs SOL"). Never a bet failure. */
  error: string | null;
  /** A failed BET send (MarketClosed, InsufficientBalance) — transient, its own note in the
   *  panel, never allowed to mask refill progress (quality-review finding, 2026-07-28). */
  betError: string | null;
}
```

Add imports at the top: `import type { PaddockStaging, StageStep } from "../chain/paddock-staging";` and extend the paddock import with `settleTicket` if not present (it already is).

Add the step sequences beside `ONBOARD_STEPS`:

```ts
/** The refill path, in the order cashOut + ensureBettor actually run it: the whole way out
 *  (claim → exit → undelegate → withdraw → unwrap), then the buffer back in (wrap → deposit →
 *  delegate → confirm). `done`/`ready` are transitions, not work — the mapper collapses them
 *  to a stepless beat rather than letting indexOf(-1) yank the bar backwards. */
export const REFILL_STEPS: readonly StageStep[] = ["claim", "exit", "undelegate", "withdraw", "unwrap", "wrap", "deposit", "delegate", "confirm"];
```

In `RaceBookSource` add two optional members after `onboarding?` (~line 163):

```ts
  /** Spendable in ONE bet right now (delegated balance + auto-settleable past win), display
   *  units. Absent → `wallet()` is the gate, exactly the pre-chain behavior. */
  betable?(): number;
  /** Tell the book what stake the player has selected so it can stage/refill AHEAD of the
   *  tap. Cheap to call every frame; the staging controller throttles itself. */
  ensureFunded?(stakeUnits: number): void;
```

- [ ] **Step 4: Swap the option and rewire the chain source.** Replace `ChainBookOptions.onboard` (~line 342) with:

```ts
  /** The staging controller, when the host holds a wallet that can fund a seat. Absent → a
   *  READ-ONLY book: `onboarding()` is null, `betable()` mirrors the balance, and `placeBet`
   *  sends straight to the ER — the dev harness's shape. Present → the book reports staging
   *  progress and `ensureFunded` keeps the seat ahead of the selected stake. The tap itself
   *  NEVER stages: the 15s market does not wait, so a tap that cannot be funded is a
   *  disabled button with an honest line, not a slow flow. */
  staging?: PaddockStaging;
```

In `chainBookSource`: delete `const onboard = opts.onboard;` and `let onboardState = idleOnboarding();` (and the now-unused `idleOnboarding` / `onboardingAt` helpers if nothing else references them). Add `const staging = opts.staging;`.

Replace `openMarket`'s onboard-clearing line with nothing (staging owns its own lifecycle), keeping the rest:

```ts
    openMarket() {
      lockedMult = [];
      settled = null;
    },
```

Replace `placeBet` (~line 502) — the pure-send path, guard intact:

```ts
    placeBet(carId, amount) {
      if (!race || race.phase !== PHASE_MARKET) return; // the market is shut; the program would reject it
      if (pending !== null) return;                     // one bet in flight at a time (the panel greys the rest)
      const slot = race.entrants.indexOf(carId);
      if (slot < 0) return;
      pending = carId;
      const base = BigInt(unitsToBase(amount));
      void (async () => {
        try {
          await client.placeBet(slot, base);
          await refresh();                              // pull the landed pools/stakes back before the button frees up
        } catch (e) {
          report("placeBet", e);
          betError = messageOf(e);                      // the client's errors are written for players — pass through
        } finally {
          pending = null;
        }
      })();
    },
```

Add `let betError: string | null = null;` beside `pending`, cleared in `openMarket()` (`betError = null;`).

Replace `onboarding()` (~line 533) with the staging view:

```ts
    /** Null when this book has no staging behind it (read-only) — the balance on screen is
     *  then the whole story and the panel gates on it exactly as before. */
    onboarding() {
      if (!staging) return null;
      const s = staging.status();
      // A refill that ERRORS must still read as a refill — latch the kind while the state
      // machine is telling us, so "error" doesn't relabel a ten-minute-player as first-time.
      if (s.state === "refilling") lastKind = "refill";
      else if (s.state === "staging") lastKind = "setup";
      const kind = s.state === "error" ? lastKind : s.state === "refilling" ? "refill" : "setup";
      const working = s.state === "staging" || s.state === "refilling";
      const seq = kind === "refill" ? REFILL_STEPS : ONBOARD_STEPS;
      if (s.state === "idle" || s.state === "ready") {
        return s.error || betError ? { kind, working, step: null, index: 0, of: seq.length, error: s.error, betError } : null;
      }
      const step = s.step === "done" || s.step === "ready" ? null : s.step;
      const i = step ? seq.indexOf(step) : -1;
      return { kind, working, step, index: i < 0 ? 0 : i + 1, of: seq.length, error: s.error, betError };
    },
```

Add the two new members before `claimWindow`:

```ts
    /** balance + a past ticket's claimable win — what ONE bet can spend right now, because
     *  place_bet auto-settles the old ticket before its balance check (proven live). The
     *  math lives in paddock-staging's exported `betableOf`; import it, don't re-derive.
     *  EXPOSED ONLY WHEN STAGING IS WIRED: on a read-only book, `betable !== null` would
     *  tell the panel a seat exists behind the number and it would paint top-up copy for a
     *  top-up that can never happen. Absent → the panel gates on `wallet()`, the read-only
     *  book's honest whole story. Same for `ensureFunded`. */
    betable: staging ? () => baseToUnits(betableOf(race, bettor)) : undefined,

    ensureFunded: staging ? (stakeUnits: number) => {
      // Feed the controller what THIS module just read off the chain — its own cache only
      // updates when a staging run executes, so without the observation a drained balance
      // would short-circuit "ready" forever and the silent refill would never fire.
      // Conditional like `betable`: a read-only book has no seat to keep funded.
      const observed = race && bettor ? betableOf(race, bettor) : undefined;
      staging.ensure(BigInt(unitsToBase(stakeUnits)), observed);
    } : undefined,
```

Change `wallet()` to the raider-style one number (the panel's Wallet line reads as "my money", not an internal ledger):

```ts
    /** ONE number, the way the perps chip shows wallet+play together: the delegated balance,
     *  a past ticket's claimable win, and the L1 SOL still in the wallet. The BET gate is
     *  betable(), which is ≤ this — the difference is money that needs a (background) refill
     *  crossing before a bet can spend it. */
    wallet: () => baseToUnits(betableOf(race, bettor))
      + (staging ? baseToUnits(staging.walletSolBase()) : 0),
```

- [ ] **Step 5: Fix `createChainBookSource` to prime staging balances** (~line 628) so `betable` is honest on the first frame:

```ts
export async function createChainBookSource(
  client: PaddockBookReader,
  opts: ChainBookOptions = {},
): Promise<RaceBookSource & { refresh(): Promise<void> }> {
  const src = chainBookSource(client, opts);
  await src.refresh();
  if (src.phase() === null) throw new Error("paddock: no Race account in the ER for this book mint");
  return src;
}
```

(unchanged shape — the priming read already fills `race`/`bettor`; nothing more needed here).

- [ ] **Step 6: Run the suite**

Run: `cd redline3d && npx vitest run src/render/race-book-source.test.ts`
Expected: PASS. Also run `npx vitest run src/chain/` to catch ripples.

- [ ] **Step 7: Typecheck and commit**

```bash
cd redline3d && npx tsc --noEmit
git add src/render/race-book-source.ts src/render/race-book-source.test.ts
git commit -m "race book: staging seam replaces tap-onboarding — BET is one ER send, seat stays ahead of the stake"
```

Note: `race-preview.ts` still passes `onboard:` — it breaks the typecheck here and is fixed in Task 6 (it moves to the staging option too). If the typecheck failure blocks the commit, fold the race-preview one-liner from Task 6 Step 4 into this commit instead.

---

### Task 4: Bet panel — gate on betable, one-number wallet, setup vs top-up notes

**Files:**
- Modify: `redline3d/src/ui/bet-panel.ts`
- Modify: `redline3d/src/ui/bet-panel.test.ts`

- [ ] **Step 1: Update panel tests.** Search bet-panel.test.ts for `canFund` / `onboarding` gate tests. New behavior to assert:

```ts
// BET disabled when betable < stake even though onboarding is non-null (the old clause is gone)
it("gates BET on betable, not on the presence of onboarding", () => { /* ctx.betable = 1, selStake 5, onboarding non-null → button disabled */ });
// falls back to wallet when betable is absent (local sim unchanged)
it("gates on wallet when the book reports no betable", () => { /* ctx.betable = null, wallet 100 → enabled */ });
// refill note paints its own head
it("paints a top-up note for kind refill", () => { /* onboarding {kind:"refill", step:"undelegate", ...} → head matches /Topping up/ */ });
// selectedStake getter
it("exposes the selected stake", () => { /* default 5; tap $1 chip → 1 */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd redline3d && npx vitest run src/ui/bet-panel.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In bet-panel.ts:

Export the default stake and add `betable` to the ctx (line ~30):

```ts
export const DEFAULT_STAKE = 5;
```

```ts
  wallet: number;                // the player's money as ONE number (wallet + staged + claimable)
  betable: number | null;        // what one bet can spend RIGHT NOW; null → wallet is the gate (local sim)
```

Replace the `canFund` line (~line 359) — the balance story is honest again:

```ts
      const betable = ctx.betable ?? ctx.wallet;
      // A seat mid-move cannot take a bet: while the controller is working — even between
      // steps — the delegated pair may be undelegated and the balance can read off a stale
      // clone. `working` is the controller's own word for it; `step` alone has stepless gaps.
      const stagingInFlight = ctx.onboarding?.working ?? false;
      const canFund = betable >= selStake && !stagingInFlight;
```

When BET is disabled by a short balance on a staged chain book (`ctx.betable !== null` — the
book only exposes `betable` when staging is wired) with nothing in flight and no error — the
refill's quiet debounce windows — the panel paints a soft deadline-free one-liner (head
"Balance short", body "Not enough staged for a $N bet — the seat is topping up in the
background.") so a disabled BET always has an honest line under it. No copy anywhere in the
panel promises a market count or a clock — the refill takes ~2 race cycles and the panel's
voice rule is that the sequence is the progress, the duration is not ours to promise.

Extend the step labels (replace `ONBOARD_LABEL`, ~line 62) — one map covers both kinds:

```ts
const STEP_LABEL: Record<NonNullable<BookOnboarding["step"]>, string> = {
  join: "Opening your account at the book",
  wrap: "Wrapping SOL to stake",
  deposit: "Staking your seat",
  delegate: "Delegating your seat to the rollup",
  confirm: "Waiting for the rollup to take your seat",
  ready: "Seat ready",
  claim: "Collecting your last win",
  exit: "Freeing your seat to top it up",
  undelegate: "Waiting for the rollup to hand it back",
  withdraw: "Gathering your balance",
  unwrap: "Unwrapping to SOL",
  done: "Seat freed",
};
```

Replace `onboardNote` (~line 77) with TWO note builders — staging progress/errors and bet
failures are independent facts and render as separate stacked notes (a bet error must never
mask refill progress):

```ts
function onboardNote(o: BookOnboarding | null): Note | null {
  if (!o) return null;
  if (o.error) {
    const head = o.kind === "refill" ? "Top-up stopped" : "Setup stopped";
    return { cls: "stopped", head, body: o.error };
  }
  if (!o.step) return null;
  const head = o.kind === "refill" ? `Topping up · ${o.index} of ${o.of}` : `One-time setup · ${o.index} of ${o.of}`;
  const body = o.kind === "refill"
    ? `${STEP_LABEL[o.step] ?? o.step} — betting reopens when your seat is back.`
    : `${STEP_LABEL[o.step] ?? o.step} — later bets skip all of this.`;
  return { cls: "", head, body };
}

/** A failed bet send, as its own note beside (never instead of) staging progress. */
function betNote(o: BookOnboarding | null): Note | null {
  if (!o?.betError) return null;
  return { cls: "stopped", head: "Bet not placed", body: o.betError };
}
```

Render `betNote` in the same notes area the panel already stacks `onboardNote` + `claimNote` in.

Add the getter to the `BetPanel` interface (~line 48) and the returned object:

```ts
  /** The stake chip currently selected — the host feeds it to the book's ensureFunded so the
   *  seat is staged for the bet the player is ABOUT to make, not the one they last made. */
  selectedStake(): number;
```

```ts
    selectedStake: () => selStake,
```

- [ ] **Step 4: Run the panel suite**

Run: `cd redline3d && npx vitest run src/ui/bet-panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit** (race-mode still passes no `betable` — if tsc flags the missing ctx field at the race-mode call site, add `betable: book.betable?.() ?? null,` there now; it is Task 5's first step regardless).

```bash
cd redline3d && npx tsc --noEmit
git add src/ui/bet-panel.ts src/ui/bet-panel.test.ts
git commit -m "bet panel: gate on betable, one-number wallet, top-up notes — funding is no longer a flow"
```

---

### Task 5: race-mode — thread betable + feed the staging trigger

**Files:**
- Modify: `redline3d/src/render/race-mode.ts` (ctx assembly ~line 702; frame loop near `book.poll(dt)` ~line 540)

- [ ] **Step 1: Extend the panel ctx** (~line 702):

```ts
    betPanel.render({
      ...
      wallet: book.wallet(),
      betable: book.betable?.() ?? null,
      ...
    });
```

- [ ] **Step 2: Feed the staging trigger in the frame loop**, right after `book.poll(dt);` (~line 540):

```ts
    book.poll(dt);
    // Keep the seat staged for the stake the player has SELECTED — the governing rule is
    // "never start a slow chain operation on a BET tap; start it the moment you know it
    // will be needed", and the selected chip is that moment. The controller behind this
    // throttles itself; per-frame cost is a function call and a compare.
    book.ensureFunded?.(betPanel.selectedStake());
```

- [ ] **Step 3: Run the race-mode tests + typecheck**

Run: `cd redline3d && npx vitest run src/render/race-mode.test.ts && npx tsc --noEmit`
Expected: PASS (the local sim has no `betable`/`ensureFunded`, both optional-chained).

- [ ] **Step 4: Commit**

```bash
git add src/render/race-mode.ts
git commit -m "race-mode: thread betable to the panel, keep the seat staged for the selected stake"
```

---

### Task 6: main.ts — Privy wallet drives the real book; cash-out brings it all home

**Files:**
- Modify: `redline3d/src/main.ts` (imports ~line 96-102; module state ~line 947; `enterGrandprix` ~line 1221; wallet-panel `cashOut` ~line 548)
- Modify: `redline3d/src/race-preview.ts` (~line 177 — the harness moves to the staging option)

- [ ] **Step 1: Add imports and the lazy per-address paddock pair.** Near the session construction (~line 212):

```ts
import { createPaddockBook, LiveStakesError, type PaddockBook } from "./chain/paddock";
import { createPaddockStaging, type PaddockStaging } from "./chain/paddock-staging";
import { createChainBookSource } from "./render/race-book-source";
import { DEFAULT_STAKE } from "./ui/bet-panel";
import { unitsToBase } from "./core/stake-currency";
import { CHAIN } from "./chain/config";
```

(keep only the ones not already imported — `CHAIN` and some others may exist; check the import block.)

Below the `session` construction:

```ts
// The paddock book rides the SAME signer as everything else on chain — session.anchorWallet()
// is the documented seam for that (crate-roll VRF already uses it). Lazy and keyed by address:
// loginFresh can change the wallet, and the old account's staging must not leak into the new one.
let paddockPair: { client: PaddockBook; staging: PaddockStaging; address: string } | null = null;
function paddockFor(): { client: PaddockBook; staging: PaddockStaging } | null {
  const w = session.anchorWallet();
  if (!w) return null;
  const address = w.publicKey.toBase58();
  if (paddockPair?.address !== address) {
    paddockPair?.staging.dispose();
    const client = createPaddockBook({ wallet: w, mint: CHAIN.PADDOCK_BOOK_MINT });
    paddockPair = { client, staging: createPaddockStaging({ client }), address };
  }
  return paddockPair;
}
```

- [ ] **Step 2: Build the chain book on grandprix entry.** Replace `enterGrandprix` (~line 1221) with an async-building version. The sync guards stay first; the await sits between them and the construction, with the guards re-checked after it (a double-tap or mode change during the await must not double-build):

```ts
function enterGrandprix(playerCarName: string | null): void {
  if (mode === "grandprix" || raceGame) return;                          // re-entry guard: a double-tapped race button (Android retargets the trailing click) would orphan + leak a whole race
  if (modeSwitchBlocked({ opening, phase: engine.getPhase() })) return;  // no mode switch mid-GO
  void (async () => {
    // A connected wallet plays the REAL book — the same singleton Race the crank cycles on
    // devnet; a guest keeps the local sim byte-for-byte (book absent ⇒ pre-chain behavior).
    // Build it BEFORE the mode flips: one primed ER read (~a snapshot), and on any failure
    // the race still opens on the local sim rather than half-opening on a dead chain.
    let book: Awaited<ReturnType<typeof createChainBookSource>> | undefined;
    const pad = paddockFor();
    if (pad) {
      try {
        book = await createChainBookSource(pad.client, { staging: pad.staging });
        // The moment we know a bet will be needed is NOW — stage the default stake's buffer
        // while the player is still watching the market fill in.
        pad.staging.ensure(BigInt(unitsToBase(DEFAULT_STAKE)));
      } catch (e) {
        console.warn("[grandprix] chain book unavailable — local sim:", e);
      }
    }
    if (mode === "grandprix" || raceGame) return;                        // re-check across the await
    if (modeSwitchBlocked({ opening, phase: engine.getPhase() })) return;
    const seed = (Math.random() * 1e9) >>> 0;
    raceGame = createRaceGame({
      scene: ctx.scene, camera: ctx.camera, hudParent: hudRoot,
      grid: buildGrid(CAR_DEFS.filter((c) => !c.locked || inventory.owns(c.name)), playerCarName, mulberry32(seed)),
      seed, lowTier: quality.tier === "low",
      book,
      provideSceneLighting: true,
      exposure: { get: () => ctx.renderer.toneMappingExposure, set: (v) => { ctx.renderer.toneMappingExposure = v; } },
      onExit: () => exitGrandprixToHome(),
    });
    mode = "grandprix";
    // ... the rest of the original body, unchanged, from `if (world) world.group.visible = false;`
    // through `coins.setVisible(false); scrap.setVisible(false);`
  })();
}
```

(The original body from the visibility/light mutations down is moved verbatim inside the async closure — nothing in it changes.)

- [ ] **Step 3: Fold the race book into the wallet panel's cash-out** (~line 548):

```ts
    cashOut: async () => {
      if (session.delegated()) await session.endSession(); // undelegate under the hood
      await session.withdraw();
      // The race book comes home through the same door — one Cash Out returns ALL the money
      // (the player never sees the seat lifecycle). A seat riding the LIVE race cannot exit
      // yet: that is normal play, and the bet panel is already saying so; skip quietly.
      const pad = paddockFor();
      if (pad) {
        try { await pad.client.cashOut(); }
        catch (e) {
          if (e instanceof LiveStakesError) console.warn("race book cash-out deferred — stakes riding the live race");
          else throw e;
        }
      }
    },
```

- [ ] **Step 4: Move the dev harness to the staging option** (race-preview.ts ~line 177-186). Replace the `onboard:`-passing construction:

```ts
  const wallet = portToAnchorWallet(createDevKeypairPort());
  const client = createPaddockBook({ wallet, mint: CHAIN.PADDOCK_BOOK_MINT });
  const staging = betMode ? createPaddockStaging({ client }) : undefined;
  const book = await createChainBookSource(client, { staging });
  if (betMode) staging!.ensure(DEV_DEPOSIT_LAMPORTS);
```

with `import { createPaddockStaging } from "./chain/paddock-staging";` added to the imports. (`DEV_DEPOSIT_LAMPORTS` keeps meaning "what the harness stages", now as the ensure() argument; `?deposit=` still overrides it.)

- [ ] **Step 5: Full suite + typecheck**

Run: `cd redline3d && npx vitest run && npx tsc --noEmit`
Expected: all green (1207+ passing, count grows with the new suites), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/race-preview.ts
git commit -m "grandprix: a Privy sign-in bets the real book — staged on entry, cashed out through the one Cash Out"
```

---

### Task 6 addendum (quality-review findings, 2026-07-28 — all accepted)

1. **CRITICAL — the Cash Out gate must see the book.** `wallet.ts` disables the button on
   `playCents <= 0`, which reads only the perps balance — a Watch-&-bet-only player has SOL
   staged in the seat and a disabled way out. `status()` must incorporate the paddock seat
   (last-known synchronously; refreshed by an async read when the panel opens, since the
   staging cache reads 0 before any run).
2. **The panel's paddock leg routes through the controller**: `PaddockStaging.cashOutNow()`
   — takes the same single-flight slot as the refill (two sequences must never drive the
   same PDAs), reports steps through status, rethrows `LiveStakesError` for the caller's
   own message, and **suspends** the controller so the frame-loop's `ensureFunded` cannot
   re-stage the money the player just withdrew (the boomerang). `resume()` clears the
   suspension; `enterGrandprix`'s staging kick calls it — a fresh race entry is the player
   opting back in.
3. The deferred path (`LiveStakesError`) gets its own status line — never the success line.
4. `syncOnchainBalance()` moves after the paddock leg; the leg's steps thread into
   `hud.setStatus` so ~80s of undelegate polling doesn't render as a dead button.
5. `enterGrandprix` re-check also asserts the FROM mode: `const from = mode;` before the
   await, bail when `mode !== from` (an async open must not build over highway/lobby).
6. Logout disposes `paddockPair` (it currently survives with the old address).

**Files:** none (verification only)

- [ ] **Step 1: Revive the crank if needed** (it has died twice — a stalled book takes no bets and invalidates everything below):

```bash
cd onchain/raider && ANCHOR_WALLET=$HOME/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com node scripts/paddock-house-setup.mjs
```

Expected: steps 1–3 SKIP; step 4 either "a crank is already running" or ARMED.

- [ ] **Step 2: Browser-verify the REAL game path with the dev wallet.** Start the `redline3d-paddock` launch config (port 4200) and open `http://localhost:4200/?wallet=dev`. From home, tap **Watch & bet**. Verify, in order:
  - The race on screen tracks the devnet book (compare phase/seq against an out-of-band read — the same node probe used on 2026-07-28).
  - Entry staged the seat: the dev wallet (`DwVzZV…UMpLy`, pinned by VITE_DEV_SECRET) shows fresh L1 transactions on entry, NOT on the first tap — unless it is already delegated from the morning's session, in which case status must go straight to ready with zero sends.
  - During MARKET, BET on a car: the bet lands within the same market (pool moves, slip shows the position) — single ER send.
  - The Wallet line shows one combined number; after the bet it drops by the stake.
  - Let the race settle; verify win/loss shows on the FINISH card and, on a win, the next bet auto-collects it.
  - `?wallet=dev` **absent** + not signed in (guest): race runs on the local sim exactly as before (fake $100 wallet, no chain traffic).
- [ ] **Step 3: Verify the balance math on-chain** after one bet, with the node probe: bettor balance + ticket stakes reconcile with what the panel showed, to the lamport.
- [ ] **Step 4: The Privy run (with the user).** The user signs in with Privy on `http://localhost:4200/`. Then:
  - Get their embedded wallet address (wallet panel shows it).
  - Fund it ourselves per standing directive — transfer from the house/dev wallet or faucet (~0.3 SOL covers a $25 buffer + fees + rent).
  - They enter the race and bet during a market. Expected: first entry stages (~30-40s if fresh), after which taps land instantly; the wallet panel Cash Out returns everything afterward.
- [ ] **Step 5: Commit any verification fixes, update the handoff docs' status lines if the session ends here.**

---

## Explicitly out of scope

- **The crank watchdog** — separate, urgent, user-acknowledged; Task 7 Step 1 papers over it per-session only.
- **VRF swap, program/Rust changes, redeploys** — none needed.
- **Top-up button / funding screen / buy-in denominations** — rejected by the user ("no chips, direct betting").
- **Mainnet** — devnet only until the VRF gate closes.

## Self-review notes

- Spec coverage: entry staging (governing rule) → Tasks 2/6; single-send bet → Tasks 1/3; silent refill → Task 2; honest disabled-BET lines → Task 4; one-number wallet → Tasks 3/4; guest fallback → Task 6; copy + latency polish → Task 1; cash-out fold-in → Task 6; prerequisite wiring (§6.4 of the first-bet handoff) → Task 6.
- Type consistency: `StageStatus`/`StageStep`/`PaddockStaging` defined once (Task 2), consumed in Tasks 3/4/6; `BookOnboarding.kind` defined Task 3, consumed Task 4; `DEFAULT_STAKE` defined Task 4, consumed Task 6; `betable`/`ensureFunded` optional members defined Task 3, consumed Tasks 4/5.
- The deleted `idleOnboarding`/`onboardingAt` helpers and `ChainBookOptions.onboard` have no remaining references after Tasks 3/6 (race-preview was the last caller).
