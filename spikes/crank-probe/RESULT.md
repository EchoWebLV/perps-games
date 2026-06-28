# crank-probe — ScheduleTask availability on the devnet ER validator

**Task 8 verdict gate.** Does the public devnet MagicBlock Ephemeral Rollup
validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` honor
`MagicBlockInstruction::ScheduleTask` — the native crank that lets a program
self-schedule an instruction to auto-run every N ms inside the rollup with NO
client tx?

## VERDICT: 🟢 GREEN

After `schedule_increment` and a pure `sleep` with **zero further client tx**, the
delegated `Counter` PDA auto-incremented on the ER. The validator drives the
scheduled `increment` itself. Confirmed across four independent probes; every
task stopped **exactly** at its requested iteration count.

| task | interval | iterations | result | observation |
|------|----------|-----------:|--------|-------------|
| 1   | 200 ms  | 5  | ticked 5/5  | reached 5 within the schedule-tx confirm window, then held |
| 101 | 1000 ms | 6  | ticked 6/6  | **observed ticking live during a pure sleep** (10→11, settled at 11), honored exactly 6 |
| 102 | 100 ms  | 8  | ticked 8/8  | 100 ms interval fires |
| 103 | 50 ms   | 8  | ticked 8/8  | **50 ms interval fires** (sub-100 ms works) |
| 104 | 100 ms  | 50 | ticked 50/50 | observed climbing live (54→59→65→70→76→77), honored exactly 50 |

The headline GREEN proof is **task 101**: with a 1 s interval the schedule tx
returned (counter=8, i.e. 3 cranks already fired during the ~3 s confirm) and
then the counter kept advancing to exactly 11 across a pure sleep with no client
tx — the validator was the only actor.

## Measured limits

- **Min `execution_interval_millis` that still fires:** **50 ms** (lowest probed; 50/100/200/1000 ms all fired reliably). Did not probe below 50 ms.
- **Max `iterations` honored:** at least **50** (probed; honored exactly, stopped at 50). No upper limit hit; the `ScheduleTaskArgs` field is `i64`.
- **Iteration accuracy:** exact every time — the validator runs precisely `iterations` cranks and stops. No overrun, no silent drop.

## Who pays the scheduled-tx fees

- The **`schedule_increment` tx itself is feeless on the ER** (ER tx fee = 0 lamports to the sender).
- The crank execution is funded from the **delegator's / schedule payer's MagicBlock escrow** on the base layer — i.e. the account that delegates the PDA and signs the schedule (`FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM` here). The **validator executes the crank but does not pay**; the cost comes out of the payer's delegated SOL escrow.
- Approximate cost signal: across this spike (deploy + 2 driver runs + ~79 crank executions + ER rent) the funder went 3.29 → 0.448 SOL. Deploy/buffer was ~0.46 SOL; the remaining ~2.4 SOL is delegation escrow + crank/ER operation. This is a **rough** figure — per-crank cost was not isolated precisely — but the economic source is unambiguous: the schedule payer's escrow, not the validator. Budget for crank fees when wiring this in.

## API used (verified against the crate, not guessed)

- `ephemeral-rollups-sdk` **0.15.5** (`anchor-compat`), `magicblock-magic-program-api` **0.10.1**, `anchor` 0.32.1 — same toolchain as `raider`/`lazer-probe`.
- `crank.rs` exposes `ScheduleCrankCpi { payer, magic_program, instruction_accounts, args: ScheduleTaskArgs }` and `CancelCrankCpi`. `ScheduleTaskArgs { task_id: i64, execution_interval_millis: i64, iterations: i64, instructions: Vec<Instruction> }`. Target = `MAGIC_PROGRAM_ID` (`Magic111…`).
- **Implementation note:** `ScheduleCrankCpi`'s fields all share one lifetime and take `&AccountInfo` / `&[AccountInfo]`, which fights Anchor's borrow of `ctx.accounts` (temporaries dropped while borrowed — E0716/E0597). The official `crank-counter` example sidesteps the wrapper with a direct `invoke_signed`, and so does this probe. The serialization is identical (`bincode` of `MagicBlockInstruction::ScheduleTask`, which is exactly what `Instruction::new_with_bincode` does inside the wrapper):

  ```rust
  let increment_ix = Instruction {
      program_id: crate::ID,
      accounts: vec![AccountMeta::new(ctx.accounts.counter.key(), false)],
      data: anchor_lang::InstructionData::data(&crate::instruction::Increment {}),
  };
  let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
      task_id, execution_interval_millis, iterations, instructions: vec![increment_ix],
  }))?;
  let schedule_ix = Instruction::new_with_bytes(
      MAGIC_PROGRAM_ID, &ix_data,
      vec![AccountMeta::new(payer.key(), true), AccountMeta::new(counter.key(), false)],
  );
  invoke_signed(&schedule_ix, &[payer, counter], &[])?;
  ```

- The scheduled inner instruction is the program's **own** `increment` ix bound to the Counter PDA; the validator is the executor/signer at run time. `schedule_increment` is invoked **on the ER provider** (after the Counter is delegated).

## Deploy

- Program: `crank_probe` = **`BoJm14XnRfdGrFNhHfgTxbWNi4JznqvUKtaHDweXfhLE`**
- Deploy tx: `3LNuBgKZZu2jcWK7x6vJ5a4e7ZWnnj7fKwUSFWsG58sF845A5gS9ZT1oWkBjKuVKiokVeJWYaimD7H5wEVzq6WXy`
- Last Deployed In Slot: **472648804**; authority `FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM`
- Counter PDA: `9gXNguiwG1GVf7y5r4j6k5M8MytH56i1vw3M9UPwDknQ`

## Recommendation for Task 9

**Wire the native crank.** The devnet ER validator honors `ScheduleTask`
reliably at 50 ms–1 s intervals with exact iteration counts and zero client tx —
exactly the primitive a self-driving round (e.g. a 60 s time-cap auto-close or an
intra-round liquidation tick) needs. The only operational caveat: **crank
execution is funded from the schedule payer's delegated SOL escrow**, so the
program/treasury that schedules the task must keep that escrow funded and the
fee should be sized into the round economics. A keeper-only fallback is **not**
required for liveness, but is still worth keeping as a belt-and-suspenders path
if the public validator ever drops a schedule.

## Reproduce

```bash
cd spikes/crank-probe
~/.avm/bin/anchor-0.32.1 build
solana program deploy --url "$HELIUS_DEVNET" \
  --keypair ~/.config/solana/lazer-probe.json \
  --program-id target/deploy/crank_probe-keypair.json \
  target/deploy/crank_probe.so
ANCHOR_WALLET=~/.config/solana/lazer-probe.json \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/crank-probe.ts        # the GREEN/RED gate
ANCHOR_WALLET=~/.config/solana/lazer-probe.json \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/crank-probe-limits.ts # interval/iteration limits
```
