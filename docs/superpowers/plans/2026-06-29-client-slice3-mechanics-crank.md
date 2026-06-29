# Client Slice 3 — Mid-round mechanics + native crank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Slice-1 wiring proof into the real game loop on devnet — arm the on-chain MagicBlock crank at `open` so a round auto-settles (liq/cap/time) with zero client tx, and let the player `flip` direction and `lever` leverage mid-round.

**Architecture:** Extend the existing `redline3d/src/chain/chain-round.ts` (dev-keypair, devnet, ER providers) with three owner-signed ER methods (`flip`, `lever`, `scheduleCrank`) and a full-round read (`readRound`), then wire FLIP / lev± buttons and a `setInterval`-driven on-chain status poll into the `onchain.html` / `onchain-main.ts` demo. The local `RoundEngine` keeps driving the smooth × for feel; the on-chain `Round` remains the only truth, now surfaced even when the player is idle via the poll. `main.ts` (the real 3D game) is untouched — that fold is the next slice.

**Tech Stack:** TypeScript, Vite + vitest, `@coral-xyz/anchor@0.31`, `@solana/web3.js@1.98`, the deployed `raider` program on devnet, MagicBlock Ephemeral Rollup.

---

## Background the implementer needs

- **The deployed program already ships every instruction this slice uses** (Phase 2, green on devnet): `flip(new_dir)`, `lever(new_lev)`, and `schedule_tick(task_id, interval_ms, iterations)` which arms the native crank (`tick_crank`, no-signer, validator-run). Nothing in `onchain/raider/` changes. This slice is purely client-side wiring.
- **Confirmed instruction signatures** (from the green Phase-2 tests `onchain/raider/tests/flip.ts`, `lever.ts`, `tick-liq-crank.ts`):
  - `flip(newDir)` — `newDir` a plain number `1 | -1`; accounts `{ player, house, round, mint, priceUpdate, playerAuthority }` (same set as `close`), sent on the **ER**.
  - `lever(newLev)` — `newLev` a plain number (program clamps to RMIN=10..RMAX=2000); same accounts; **ER**.
  - `scheduleTick(BN taskId, BN intervalMs, BN iterations)` — accounts `{ magicProgram, payer, player, house, round, mint, priceUpdate }`; `magicProgram` = `Magic11111111111111111111111111111111111111`; sent on the **ER**.
- **Crank escrow (the resolved known-unknown):** the validator runs `tick_crank` funded from **the schedule-payer's own SOL** — there is no separate escrow-deposit instruction. In our client the payer is the dev keypair, and `scripts/fund-wallet.mjs` already tops it up with 0.1 SOL (the Phase-2 test funds the exact same 0.1 SOL for ~200 cranks). So no new funding code is needed; the demo just needs the dev wallet to hold ≥0.1 devnet SOL.
- **The local display engine already supports mid-round changes** (`redline3d/src/core/round.ts`): `engine.setDir(newDir, price)` and `engine.setLeverage(newLev, price)` both rebank the current segment and re-anchor — exactly mirroring the on-chain terminal-first rebank.
- **Slice-1 gotchas remain in force** and are already handled by `chain-round.ts`'s `send()` helper: HTTP-send + `getSignatureStatuses` poll (not `.rpc()` WS confirm), `entryRaw·10^(-expo)` → human via `rawToHuman`, and `.accountsPartial(...)` (anchor 0.31). Reuse `send()` for the new ER methods.
- **Preview reality** (`redline3d-preview-gotchas` memory): `requestAnimationFrame` runs at ~1.5 fps in Claude Preview. That is why the on-chain settlement poll is a `setInterval`, NOT an rAF counter — `setInterval` is not throttled the way rAF is, so a crank-driven liquidation will still surface in the preview.

## File structure

- **Modify** `redline3d/src/chain/config.ts` — add `MAGIC_PROGRAM` to the `CHAIN` object (keeps all on-chain addresses in one place, like `VALIDATOR`/`DELEGATION_PROGRAM`).
- **Modify** `redline3d/src/chain/config.test.ts` — pin `MAGIC_PROGRAM`.
- **Modify** `redline3d/src/chain/chain-round.ts` — add `RoundSnap`/`ActionResult` types + two pure shapers (`roundToSnap`, `actionResultFromSnap`), then `readRound` / `flip` / `lever` / `scheduleCrank` methods and the `ChainRound` interface extension.
- **Modify** `redline3d/src/chain/chain-round.test.ts` — unit-test the two pure shapers (no network).
- **Modify** `redline3d/onchain.html` — add FLIP and lev −/+ buttons.
- **Modify** `redline3d/src/onchain-main.ts` — wire the buttons, arm the crank after `open`, and add the `setInterval` on-chain poll + a shared `finalizeSettled`.
- **Modify** `redline3d/src/chain/chain-round.devnet.test.ts` — add a gated integration test proving the crank self-settles a round with zero client `close`/`tick`.

---

### Task 1: Pin the MagicBlock task-scheduler program id in config

**Files:**
- Modify: `redline3d/src/chain/config.ts:14-17`
- Test: `redline3d/src/chain/config.test.ts`

- [ ] **Step 1: Add the failing test**

In `redline3d/src/chain/config.test.ts`, add this `it` block inside the existing `describe("CHAIN config", ...)`:

```ts
  it("pins the MagicBlock task-scheduler program id", () => {
    expect(CHAIN.MAGIC_PROGRAM.toBase58()).toBe("Magic11111111111111111111111111111111111111");
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd redline3d && npx vitest run src/chain/config.test.ts`
Expected: FAIL — `Property 'MAGIC_PROGRAM' does not exist on type` (compile error) / undefined.

- [ ] **Step 3: Add the constant**

In `redline3d/src/chain/config.ts`, inside the `CHAIN` object, add this line directly after the `DELEGATION_PROGRAM` line (line 14):

```ts
  // MagicBlock native task-scheduler program — schedule_tick CPIs the crank to this.
  MAGIC_PROGRAM: new PublicKey("Magic11111111111111111111111111111111111111"),
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd redline3d && npx vitest run src/chain/config.test.ts`
Expected: PASS (both `it` blocks).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/config.ts redline3d/src/chain/config.test.ts
git commit -m "feat(client): pin MagicBlock task-scheduler program id in CHAIN config"
```

---

### Task 2: Pure round/action shapers in chain-round

**Files:**
- Modify: `redline3d/src/chain/chain-round.ts` (add types + two exported pure functions, near the existing `SettledRound`/`OUTCOME` declarations around lines 29-31)
- Test: `redline3d/src/chain/chain-round.test.ts`

These are pure (no network): they map an anchor-decoded `Round` account into typed snapshots, so they get real unit tests. The network methods in Task 3 call them.

- [ ] **Step 1: Write the failing tests**

In `redline3d/src/chain/chain-round.test.ts`, change the import on line 3 to:

```ts
import { deriveRaiderPdas, rawToHuman, roundToSnap, actionResultFromSnap } from "./chain-round";
```

Then add these two `it` blocks inside the existing `describe("chain-round pure helpers", ...)`:

```ts
  it("roundToSnap maps an anchor-decoded round to a typed snapshot (BN -> bigint, raw -> human)", () => {
    const fake = {
      status: 1, outcome: 0, payout: { toString: () => "0" }, banked: { toString: () => "-50000" },
      dir: -1, lev: 2000, entryRaw: { toString: () => "5921756678227" }, entryExpo: 8,
      exitRaw: { toString: () => "0" }, deadlineTs: 1751000000,
    };
    const s = roundToSnap(fake);
    expect(s.status).toBe(1);
    expect(s.dir).toBe(-1);
    expect(s.lev).toBe(2000);
    expect(s.banked).toBe(-50000n); // i128 can be negative
    expect(s.outcomeName).toBe("cashout");
    expect(s.entryHuman).toBeCloseTo(59217.57, 1);
  });

  it("actionResultFromSnap exposes the settled payload only when status==2", () => {
    const base = {
      status: 1, outcome: 0, outcomeName: "cashout", payout: 0n, banked: 123n, dir: 1, lev: 100,
      entryRaw: 0n, entryExpo: 8, entryHuman: 59000, exitRaw: 0n, exitHuman: 0, deadlineTs: 0,
    };
    const open = actionResultFromSnap(base, 0n);
    expect(open.settled).toBe(false);
    if (!open.settled) { expect(open.dir).toBe(1); expect(open.banked).toBe(123n); }
    const done = actionResultFromSnap({ ...base, status: 2, outcome: 2, outcomeName: "liq" }, 4_000_000n);
    expect(done.settled).toBe(true);
    if (done.settled) { expect(done.outcomeName).toBe("liq"); expect(done.balance).toBe(4_000_000n); }
  });
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd redline3d && npx vitest run src/chain/chain-round.test.ts`
Expected: FAIL — `roundToSnap`/`actionResultFromSnap` not exported.

- [ ] **Step 3: Add the types and shapers**

In `redline3d/src/chain/chain-round.ts`, directly below the existing `SettledRound` interface and `const OUTCOME = [...]` (after line 31), add:

```ts
export interface RoundSnap {
  status: number; outcome: number; outcomeName: string;
  payout: bigint; banked: bigint; dir: number; lev: number;
  entryRaw: bigint; entryExpo: number; entryHuman: number;
  exitRaw: bigint; exitHuman: number; deadlineTs: number;
}

/** Result of a mid-round flip/lever: either re-anchored (still open) or settled (terminal-first hit). */
export type ActionResult =
  | { settled: false; banked: bigint; dir: number; lev: number; entryHuman: number }
  | ({ settled: true } & SettledRound);

/** Map an anchor-decoded Round account into a typed, BN-free snapshot. */
export function roundToSnap(r: {
  status: number; outcome: number; payout: { toString(): string }; banked: { toString(): string };
  dir: number; lev: number; entryRaw: { toString(): string }; entryExpo: number;
  exitRaw: { toString(): string }; deadlineTs: number;
}): RoundSnap {
  const entryExpo = Number(r.entryExpo);
  const entryRaw = BigInt(r.entryRaw.toString());
  const exitRaw = BigInt(r.exitRaw.toString());
  return {
    status: Number(r.status), outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?",
    payout: BigInt(r.payout.toString()), banked: BigInt(r.banked.toString()),
    dir: Number(r.dir), lev: Number(r.lev),
    entryRaw, entryExpo, entryHuman: rawToHuman(entryRaw, entryExpo),
    exitRaw, exitHuman: rawToHuman(exitRaw, entryExpo), deadlineTs: Number(r.deadlineTs),
  };
}

/** Shape a flip/lever outcome: settled payload when the action hit a terminal (status 2), else the re-anchored round. */
export function actionResultFromSnap(snap: RoundSnap, balance: bigint): ActionResult {
  if (snap.status === 2) {
    return { settled: true, outcome: snap.outcome, outcomeName: snap.outcomeName, payout: snap.payout, exitRaw: snap.exitRaw, exitHuman: snap.exitHuman, balance };
  }
  return { settled: false, banked: snap.banked, dir: snap.dir, lev: snap.lev, entryHuman: snap.entryHuman };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd redline3d && npx vitest run src/chain/chain-round.test.ts`
Expected: PASS (all helper tests).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/chain-round.ts redline3d/src/chain/chain-round.test.ts
git commit -m "feat(client): pure RoundSnap/ActionResult shapers for chain-round"
```

---

### Task 3: chain-round network methods — readRound, flip, lever, scheduleCrank

**Files:**
- Modify: `redline3d/src/chain/chain-round.ts` (extend the `ChainRound` interface ~lines 33-45; add four methods in the returned object ~after the existing `forceClose`/`commitAndUndelegate`)

These are network-bound (ER) — their behavior is proven by the gated devnet test (Task 5) and the browser (Task 6). The per-task gate here is: the build typechecks and the existing vitest suite stays green.

- [ ] **Step 1: Extend the `ChainRound` interface**

In `redline3d/src/chain/chain-round.ts`, add these four lines to the `ChainRound` interface (after the existing `readRoundStatus(...)` line):

```ts
  readRound(onEr?: boolean): Promise<RoundSnap | null>;
  flip(newDir: 1 | -1): Promise<ActionResult>;
  lever(newLev: number): Promise<ActionResult>;
  scheduleCrank(opts?: { intervalMs?: number; iterations?: number; taskId?: number }): Promise<void>;
```

- [ ] **Step 2: Implement the four methods**

In the object returned by `createChainRound`, add these methods (place them after `forceClose` and before `commitAndUndelegate`). They reuse the existing `send()` / `programER` / `pdas` / `owner` closures:

```ts
    async readRound(onEr = false) {
      const prog = onEr ? programER : program;
      const acct = await prog.account.round.fetchNullable(pdas.round);
      return acct ? roundToSnap(acct) : null;
    },

    async flip(newDir) {
      await send(erConn, programER.methods.flip(newDir).accountsPartial({
        player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED, playerAuthority: owner,
      }));
      const snap = roundToSnap(await programER.account.round.fetch(pdas.round));
      const balance = snap.status === 2 ? BigInt((await programER.account.playerBalance.fetch(pdas.player)).balance.toString()) : 0n;
      return actionResultFromSnap(snap, balance);
    },

    async lever(newLev) {
      await send(erConn, programER.methods.lever(newLev).accountsPartial({
        player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED, playerAuthority: owner,
      }));
      const snap = roundToSnap(await programER.account.round.fetch(pdas.round));
      const balance = snap.status === 2 ? BigInt((await programER.account.playerBalance.fetch(pdas.player)).balance.toString()) : 0n;
      return actionResultFromSnap(snap, balance);
    },

    async scheduleCrank(opts = {}) {
      const intervalMs = opts.intervalMs ?? 1000;
      const iterations = opts.iterations ?? 70; // ~70s coverage over the 60s round cap
      const taskId = opts.taskId ?? Date.now(); // unique per round within a session
      await send(erConn, programER.methods.scheduleTick(new BN(taskId), new BN(intervalMs), new BN(iterations)).accountsPartial({
        magicProgram: CHAIN.MAGIC_PROGRAM, payer: owner, player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED,
      }));
    },
```

- [ ] **Step 3: Typecheck + full unit suite**

Run: `cd redline3d && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all non-gated tests PASS; the `chain-round devnet loop` suite is SKIPPED (no `RAIDER_DEVNET`).

- [ ] **Step 4: Commit**

```bash
git add redline3d/src/chain/chain-round.ts
git commit -m "feat(client): chain-round flip/lever/scheduleCrank + readRound (ER)"
```

---

### Task 4: Wire FLIP / lev± buttons, arm the crank, poll on-chain settlement

**Files:**
- Modify: `redline3d/onchain.html:22-27` (button row)
- Modify: `redline3d/src/onchain-main.ts`

UI wiring — verified in the browser (Task 6). Per-task gate: build typechecks and the unit suite stays green.

- [ ] **Step 1: Add the buttons to `onchain.html`**

Replace the button row (lines 22-27) with:

```html
    <div class="row">
      <button id="session">Start session</button>
      <button id="go" disabled>GO</button>
      <button id="flip" disabled>FLIP</button>
      <button id="levminus" disabled>lev −</button>
      <button id="levplus" disabled>lev +</button>
      <button id="end" disabled>End session</button>
      <button id="withdraw" disabled>Withdraw all</button>
    </div>
```

- [ ] **Step 2: Add live-round state + `finalizeSettled` to `onchain-main.ts`**

In `redline3d/src/onchain-main.ts`, after the existing `let busy = false;` (line 20), add:

```ts
let liveDir: 1 | -1 = 1;
let liveLev = 100;
let polling = false;

// Single place a settlement (close, terminal-first flip/lever, OR the native crank) lands in the HUD.
function finalizeSettled(o: { outcome: number; outcomeName: string; payout: bigint }) {
  if (engine.getPhase() === "live") engine.cashout(priceSource.price(), Date.now()); // freeze the local visual
  setText("status", `${o.outcomeName.toUpperCase()} — payout ${usd(o.payout)} USDC.`);
  setText("mult", o.outcome === 2 ? "💥 liquidated" : `settled · +${usd(o.payout)} USDC`);
  void refreshBalance(true);
}
```

- [ ] **Step 3: Arm the crank + record dir/lev in the GO/open branch**

In the `$("go").onclick` open branch, replace the three lines from `const opened = await chain.open(...)` through the `setText("status", \`LIVE — entry ...\`)` line with:

```ts
    const opened = await chain.open(dir, lev, stake);
    roundStartMs = Date.now();
    liveDir = dir; liveLev = lev;
    engine.launch({ dir, lev, stake, entryRaw: opened.entryHuman, startMs: roundStartMs });
    (($("flip") as HTMLButtonElement).disabled = false);
    (($("levminus") as HTMLButtonElement).disabled = false);
    (($("levplus") as HTMLButtonElement).disabled = false);
    setText("status", `LIVE — entry $${opened.entryHuman.toFixed(2)}. arming crank…`);
    try {
      await chain.scheduleCrank();
      setText("status", `LIVE — entry $${opened.entryHuman.toFixed(2)}. crank armed — auto-settles. GO = cash out.`);
    } catch (e) {
      setText("status", `LIVE — entry $${opened.entryHuman.toFixed(2)}. ⚠ crank not armed (${(e as Error).message}); GO to cash out.`);
    }
```

- [ ] **Step 4: Add FLIP and lever handlers**

In `redline3d/src/onchain-main.ts`, after the `$("go").onclick` handler block, add:

```ts
$("flip").onclick = async () => {
  if (!chain || busy || !delegated || engine.getPhase() !== "live") return;
  busy = true;
  try {
    const newDir = (liveDir * -1) as 1 | -1;
    setText("status", `flipping → ${newDir === 1 ? "LONG" : "SHORT"}…`);
    const res = await chain.flip(newDir);
    if (res.settled) finalizeSettled(res);
    else {
      liveDir = newDir;
      engine.setDir(newDir, priceSource.price());
      ($("dir") as HTMLSelectElement).value = String(newDir);
      setText("status", `flipped → ${newDir === 1 ? "LONG" : "SHORT"} (gains banked).`);
    }
  } catch (e) { setText("status", `flip failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

async function changeLever(newLev: number) {
  if (!chain || busy || !delegated || engine.getPhase() !== "live") return;
  busy = true;
  try {
    setText("status", `leverage → ${newLev}×…`);
    const res = await chain.lever(newLev);
    if (res.settled) finalizeSettled(res);
    else {
      liveLev = newLev;
      engine.setLeverage(newLev, priceSource.price());
      ($("lev") as HTMLInputElement).value = String(newLev);
      setText("status", `leverage → ${newLev}× (gains banked).`);
    }
  } catch (e) { setText("status", `lever failed: ${(e as Error).message}`); }
  finally { busy = false; }
}
// Program clamps to RMIN=10..RMAX=2000; the UI doubles/halves within those bounds.
$("levplus").onclick = () => void changeLever(Math.min(2000, liveLev * 2));
$("levminus").onclick = () => void changeLever(Math.max(10, Math.floor(liveLev / 2)));
```

- [ ] **Step 5: Add the on-chain settlement poll**

In `redline3d/src/onchain-main.ts`, just above the existing `function frame()` block, add:

```ts
// Poll on-chain Round ~1.5x/s so a crank/keeper settlement surfaces even if the player never clicks.
// setInterval (not rAF) because rAF is throttled to ~1.5fps in Claude Preview.
async function pollChain() {
  if (!chain || busy || !delegated || polling || engine.getPhase() !== "live") return;
  polling = true;
  try {
    const snap = await chain.readRound(true);
    if (snap && snap.status === 2) finalizeSettled(snap);
  } catch { /* transient RPC — keep last */ }
  finally { polling = false; }
}
setInterval(() => void pollChain(), 650);
```

Also disable the FLIP/lev± buttons again when the session ends — in the `$("end").onclick` handler, alongside the existing `($("go") as HTMLButtonElement).disabled = true;`, add:

```ts
    (($("flip") as HTMLButtonElement).disabled = true);
    (($("levminus") as HTMLButtonElement).disabled = true);
    (($("levplus") as HTMLButtonElement).disabled = true);
```

- [ ] **Step 6: Typecheck + unit suite**

Run: `cd redline3d && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all non-gated tests PASS.

- [ ] **Step 7: Commit**

```bash
git add redline3d/onchain.html redline3d/src/onchain-main.ts
git commit -m "feat(client): FLIP/lev± buttons, crank-arm on open, on-chain settlement poll"
```

---

### Task 5: Gated devnet integration test — crank self-settles (zero client tx)

**Files:**
- Modify: `redline3d/src/chain/chain-round.devnet.test.ts` (add a second `it` to the existing `describe.skipIf(!RUN)` block)

This is the EV-closing proof: open a 2000× round, flip, lever, arm the crank, then **stop sending tx** and assert the round reaches `status === 2` purely from the crank. Gated on `RAIDER_DEVNET=1` (skipped in normal CI; run on demand). Mirrors `onchain/raider/tests/tick-liq-crank.ts` but driven through `chain-round`.

- [ ] **Step 1: Write the gated test**

In `redline3d/src/chain/chain-round.devnet.test.ts`, add this `it` inside the existing `describe.skipIf(!RUN)("chain-round devnet loop", () => { ... })`, after the existing loop test:

```ts
  it("opens 2000x, flips + levers, then the NATIVE CRANK settles it with zero client close/tick", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // operator: fresh mint + house funded over the 2000x pre-lock (23.75 per round)
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse().accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });

    // player: dev-keypair wallet funded with SOL (also pays the crank escrow) + test USDC
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
    const playerAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey);
    await mintTo(conn, funder, mint, playerAta.address, funder.publicKey, 5_000_000);

    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });

    await chain.buyIn(5_000_000);
    await chain.ensureRoundInited();
    await chain.delegate();

    // open 2000x, exercise the mid-round actions, then arm the crank
    await chain.open(1, 2000, 1_000_000);
    expect(await chain.readRoundStatus(true)).toBe(1);
    const afterFlip = await chain.flip(-1);
    if (!afterFlip.settled) expect(afterFlip.dir).toBe(-1); // 2000x could terminal-first; both are valid
    if (!afterFlip.settled) await chain.lever(1000);
    await chain.scheduleCrank({ intervalMs: 1000, iterations: 70 });

    // STOP touching it — poll only. The native crank must drive it to status 2 (zero client close/tick).
    const deadline = Date.now() + 90_000;
    let snap = await chain.readRound(true);
    while (Date.now() < deadline && (!snap || snap.status !== 2)) {
      await sleep(2000);
      snap = await chain.readRound(true);
    }
    expect(snap?.status).toBe(2); // settled by the crank alone
    expect([1, 2, 3]).toContain(snap!.outcome); // cap | liq | time — never cashout(0): no client close ran

    // cleanup: bring it home + withdraw
    await chain.commitAndUndelegate();
    const l1 = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(l1));
    expect(await chain.readPlayerBalance(false)).toBe(0n);
  }, 240_000);
```

- [ ] **Step 2: Confirm the test is wired (skips without the env flag)**

Run: `cd redline3d && npx vitest run --config vitest.config.devnet.ts`
Expected: the devnet suite is SKIPPED (no `RAIDER_DEVNET=1`) — confirms it compiles and is correctly gated. 0 failures.

- [ ] **Step 3: Run it live against devnet**

Run: `cd redline3d && npm run chain:itest`
Expected: PASS within ~120s — logs the loop, then the round reaches `status 2` with `outcome` in {cap, liq, time} (never cashout), proving the crank settled it with no client close/tick. The withdraw zeroes the balance.

> If it fails on a transient devnet RPC error (429 / "Internal error" / blockhash), re-run — these are flaky-faucet/public-RPC issues, not logic. The crank settling by `time` at the 60s cap makes the core assertion market-independent (it does not require a price move).

- [ ] **Step 4: Commit**

```bash
git add redline3d/src/chain/chain-round.devnet.test.ts
git commit -m "test(client): devnet — native crank self-settles a 2000x round, zero client tx"
```

---

### Task 6: Browser verification in Claude Preview

**Files:** none (verification only). Follows the `verify-UI-in-browser-before-done` rule.

- [ ] **Step 1: Start the dev server**

Run: `cd redline3d && npm run dev` (port 3000) and open `/onchain.html` in Claude Preview.

- [ ] **Step 2: Fund the shown wallet (one-time per fresh keypair)**

Read the `wallet:` address from the page, then:
Run: `cd redline3d && node scripts/fund-wallet.mjs <ADDR> 8tZXkKuat9KoisUjFkq4kBUa1p746Mn4tj4i3st5Th1Y`
Expected: "transferred 0.1 SOL" (if needed) + "minted 10000000 test-USDC". The 0.1 SOL also funds the crank escrow.

- [ ] **Step 3: Drive the mid-round mechanics**

Start session → set lev e.g. 100 → GO (opens; status should read "crank armed"). Click **FLIP** and confirm dir flips + status shows "gains banked"; click **lev +** / **lev −** and confirm the `lev` field and status update. Capture a `preview_snapshot` of the HUD after each.
Expected: each action lands on-chain (no error in `preview_console_logs`) and the local × keeps moving.

- [ ] **Step 4: Watch a round self-liquidate via the crank (the headline proof)**

End any open round, then open a fresh **lev 2000** round and **do NOT click GO/cash out** — wait. Within ~60s the on-chain poll must flip the HUD to a settled/liquidated state (`💥 liquidated` or `settled · +… USDC`) driven by the crank alone. Capture a `preview_screenshot` of the settled HUD.
Expected: the round settles with zero cash-out click — visible proof the money model is enforced on-chain.

- [ ] **Step 5: Finish the session**

End session → Withdraw all → confirm `play balance` returns to 0.00 and status shows the withdraw line.

- [ ] **Step 6: Commit (verification note only, if anything was tweaked)**

If Steps 3-5 surfaced a fix, make it in the source and re-verify from Step 3. Otherwise no commit — the browser proof is the deliverable.

---

## Self-review notes

- **Spec coverage:** flip + lever (Tasks 3-4) ✓; crank arm at open (Task 3 `scheduleCrank` + Task 4 GO branch) ✓; on-chain status poll surfacing idle settlement (Task 4 `setInterval` + `pollChain`) ✓; crank-escrow funding (resolved — payer SOL via `fund-wallet.mjs`, Task 6 Step 2) ✓; headless devnet self-settle proof (Task 5) ✓; Claude Preview verification incl. watch-it-liquidate (Task 6) ✓. Out-of-scope items (session keys, 3D `main.ts` fold, keeper loop, `cancel_tick`) are correctly absent.
- **Type consistency:** `RoundSnap` / `ActionResult` defined in Task 2, consumed unchanged in Tasks 3-5; method names `flip` / `lever` / `scheduleCrank` / `readRound` match across the interface (Task 3), the demo (Task 4) and the test (Task 5); engine methods `setDir` / `setLeverage` / `cashout` exist in `core/round.ts`; `CHAIN.MAGIC_PROGRAM` defined in Task 1, used in Task 3.
- **No placeholders:** every step has concrete code/commands and expected output. Instruction signatures and the crank-escrow path are taken verbatim from the green Phase-2 tests, not assumed.
