// Task 9 — self-driving liquidation proof: the NATIVE MagicBlock crank
// (`schedule_tick` → validator auto-runs `tick_crank`) closes an underwater 2000x
// round on the ER with ZERO client per-tick tx. NO keeper loop runs.
//
// Identical mint/house/session/delegate/open plumbing to tests/tick-liq.ts. The
// ONLY change: after both opens, instead of runKeeper(...) we call `schedule_tick`
// ONCE per side on the ER provider (distinct task_id per side). The validator then
// drives `tick_crank` on the schedule; we send NO further tx and merely POLL
// `round.status` until both settle (or a timeout). Whichever 2000x side crosses the
// ~0.04% liq band is settled by the crank with payout 0; we assert the same liq /
// lock-released / value-conserved invariants as tick-liq.ts — but the headline proof
// is that the liquidation happened with NO keeper / zero client per-tick tx.
//
// MARKET/DEADLINE NOTE (same as tick-liq): at 2000x a liq needs only a ~0.04%
// adverse move, but it must cross WITHIN the round's time-cap or `tick_crank`
// settles `time` instead. We run on the test-long-deadline (180s) build so one
// entry is held long enough for the crank to observe the cross even on a calm,
// mean-reverting feed. Each attempt re-opens a FRESH window (cheap, no
// re-delegation) and re-schedules a fresh task_id; we retry up to ATTEMPTS times.
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/raider.json");
const { BN } = anchor;

const {
  BASE_RPC,
  BASE_WS,
  ER_RPC,
  ER_WS,
  BTC_FEED,
  VALIDATOR,
  sleep,
  sendIxHttp,
  deriveTill,
  maxPayout,
} = require("./helpers");

const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111"
);

const STAKE = 1_000_000;
const ASSET_BTC = 0; // multi-asset: 0 = BTC = BTC_FEED
// Crank schedule: 1 crank/sec/side covers the 180s round (200 iters ≈ 200s of
// coverage). Modest crank count keeps the schedule-payer's ER escrow cost low.
const INTERVAL_MS = Number(process.env.CRANK_INTERVAL_MS || 1000);
const ITERATIONS = Number(process.env.CRANK_ITERATIONS || 200);
// Poll window: read round.status every POLL_MS until both settle, capped by
// MAX_POLL_MS (~200s — a touch over the 180s deadline so a worst-case time-cap on
// the non-liq side still resolves before we give up).
const POLL_MS = Number(process.env.POLL_MS || 2000);
const MAX_POLL_MS = Number(process.env.MAX_POLL_MS || 200_000);
const ATTEMPTS = Number(process.env.LIQ_ATTEMPTS || 3);

describe("raider — self-driving 2000x liquidation via native crank (zero client tx)", function () {
  this.timeout(1_000_000);
  const funder = anchor.Wallet.local();
  const baseConn = new anchor.web3.Connection(BASE_RPC, {
    wsEndpoint: BASE_WS,
    commitment: "confirmed",
  });
  const baseProvider = new anchor.AnchorProvider(baseConn, funder, {
    commitment: "confirmed",
  });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  it("opens long+short 2000x; the underwater side liquidates via the native crank (payout 0, lock released, conserved) — NO keeper, zero client per-tick tx", async () => {
    const conn = baseConn;

    // One independent mint + house PER SIDE (same reasoning as tick-liq.ts: a
    // shared HouseBalance PDA can only be delegated once). Setup (mint/house/
    // buy_in/delegate + the ~8s delegation wait) is done for BOTH sides first; the
    // `open` thunks fire together AFTER so both 180s deadlines start fresh in
    // lockstep.
    async function setupSide(dir) {
      const mint = await createMint(
        conn,
        funder.payer,
        funder.publicKey,
        null,
        6
      );
      const [housePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("house2"), mint.toBuffer()],
        program.programId
      );
      const [feedRegistry] = PublicKey.findProgramAddressSync(
        [Buffer.from("feeds")],
        program.programId
      );
      const [vaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), mint.toBuffer()],
        program.programId
      );
      const vaultToken = getAssociatedTokenAddressSync(
        mint,
        vaultAuthority,
        true
      );

      await program.methods
        .initHouse(new anchor.BN(0))
        .accounts({
          authority: funder.publicKey,
          mint,
          house: housePda,
          vaultAuthority,
          vaultToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true });

      // Fund this side's house for repeated 2000x rounds (>= 23.75 pre-lock each).
      const HOUSE_FUND = 30_000_000;
      const funderAta = await getOrCreateAssociatedTokenAccount(
        conn,
        funder.payer,
        mint,
        funder.publicKey
      );
      await mintTo(
        conn,
        funder.payer,
        mint,
        funderAta.address,
        funder.publicKey,
        HOUSE_FUND
      );
      await program.methods
        .fundHouse(new BN(HOUSE_FUND))
        .accounts({
          funder: funder.publicKey,
          mint,
          house: housePda,
          funderToken: funderAta.address,
          vaultAuthority,
          vaultToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ skipPreflight: true });

      const session = Keypair.generate();
      // Session needs SOL to pay the open + schedule_tick fees AND to fund the
      // MagicBlock crank escrow (the validator runs tick_crank funded from the
      // schedule payer's delegated SOL). 0.1 SOL is plenty for ~200 cheap cranks.
      await baseProvider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: funder.publicKey,
            toPubkey: session.publicKey,
            lamports: 0.1 * LAMPORTS_PER_SOL,
          })
        )
      );
      const sp = new anchor.AnchorProvider(
        baseConn,
        new anchor.Wallet(session),
        { commitment: "confirmed" }
      );
      const pAs = new anchor.Program(idl, sp);
      const [player] = PublicKey.findProgramAddressSync(
        [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()],
        program.programId
      );
      const [round] = PublicKey.findProgramAddressSync(
        [Buffer.from("round"), session.publicKey.toBuffer()],
        program.programId
      );
      const till = deriveTill(program.programId, mint, session.publicKey); // per-session till (was the shared house)
      const ownerAta = await getOrCreateAssociatedTokenAccount(
        conn,
        funder.payer,
        mint,
        session.publicKey
      );
      await mintTo(
        conn,
        funder.payer,
        mint,
        ownerAta.address,
        funder.publicKey,
        5_000_000
      );
      await pAs.methods
        .buyIn(new BN(5_000_000))
        .accounts({
          owner: session.publicKey,
          mint,
          player,
          ownerToken: ownerAta.address,
          vaultAuthority,
          vaultToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true });
      await pAs.methods
        .initRound()
        .accounts({
          owner: session.publicKey,
          round,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true });
      // slice_from_pot: carve this session's till off the master pot BEFORE delegating it.
      await pAs.methods
        .sliceFromPot(new BN(maxPayout(STAKE)))
        .accounts({
          owner: session.publicKey,
          mint,
          master: housePda,
          till,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ skipPreflight: true });
      // HTTP-confirm the delegate CPI (WS confirmation is flaky for this heavy tx).
      await sendIxHttp(
        conn,
        pAs.methods
          .delegateSession()
          .accounts({
            payer: session.publicKey,
            mint,
            player,
            house: till,
            round,
          })
          .remainingAccounts([
            { pubkey: VALIDATOR, isSigner: false, isWritable: false },
          ]),
        session
      );
      const erProvider = new anchor.AnchorProvider(
        new anchor.web3.Connection(ER_RPC, {
          wsEndpoint: ER_WS,
          commitment: "confirmed",
        }),
        new anchor.Wallet(session),
        { commitment: "confirmed" }
      );
      const programER = new anchor.Program(idl, erProvider);
      // wait for delegation to land before the round can be opened in-rollup
      await sleep(8000);
      const open = () =>
        programER.methods
          .open(ASSET_BTC, dir, 2000, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0)
          .accounts({
            player,
            house: till,
            round,
            mint,
            priceUpdate: BTC_FEED,
            registry: feedRegistry,
            playerAuthority: session.publicKey,
          })
          .signers([session])
          .rpc({ skipPreflight: true });
      // Arm the native crank on the ER: validator auto-runs tick_crank on this
      // round every INTERVAL_MS for ITERATIONS runs. Distinct task_id per call so a
      // re-open on a later attempt schedules a fresh task. Pass the TILL as `house`
      // (the forwarded key); the scheduled tick_crank re-derives the till by seed.
      const schedule = (taskId) =>
        programER.methods
          .scheduleTick(new BN(taskId), new BN(INTERVAL_MS), new BN(ITERATIONS))
          .accounts({
            magicProgram: MAGIC_PROGRAM_ID,
            payer: session.publicKey,
            player,
            house: till,
            round,
            mint,
            priceUpdate: BTC_FEED,
          })
          .signers([session])
          .rpc({ skipPreflight: true });
      return {
        session,
        programER,
        housePda,
        till,
        open,
        schedule,
        accounts: { player, house: till, round, mint, btcFeed: BTC_FEED },
      };
    }

    // Run the two slow setups SEQUENTIALLY to avoid bursting the public devnet RPC
    // (same 429-avoidance reasoning as tick-liq.ts). `open` is deferred so the two
    // opens still fire together below with fresh, lockstep deadlines.
    const long = await setupSide(1);
    const short = await setupSide(-1);

    let lr,
      sr,
      liqAttempt = 0;
    let longBalBeforeOpen, shortBalBeforeOpen;
    // task_id namespace: side*1000 + attempt, so every (side, attempt) is unique.
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const lh = await long.programER.account.houseBalance.fetch(long.till);
      const sh = await short.programER.account.houseBalance.fetch(
        short.till
      );
      longBalBeforeOpen = BigInt(lh.balance.toString());
      shortBalBeforeOpen = BigInt(sh.balance.toString());
      assert.equal(
        lh.locked.toString(),
        "0",
        "long house lock free before open"
      );
      assert.equal(
        sh.locked.toString(),
        "0",
        "short house lock free before open"
      );

      // Open both 2000x positions back-to-back so the time-caps start together.
      await Promise.all([long.open(), short.open()]);

      const longLockedAfterOpen = BigInt(
        (
          await long.programER.account.houseBalance.fetch(long.till)
        ).locked.toString()
      );
      const shortLockedAfterOpen = BigInt(
        (
          await short.programER.account.houseBalance.fetch(short.till)
        ).locked.toString()
      );
      assert.equal(
        longLockedAfterOpen.toString(),
        23_750_000n.toString(),
        "long 2000x round pre-locked 23.75"
      );
      assert.equal(
        shortLockedAfterOpen.toString(),
        23_750_000n.toString(),
        "short 2000x round pre-locked 23.75"
      );

      // Arm the native crank on BOTH sides (distinct task_id each). This is the ONLY
      // settlement-driving tx of the attempt — the validator does the rest.
      const longTask = 1000 + attempt;
      const shortTask = 2000 + attempt;
      const lsig = await long.schedule(longTask);
      const ssig = await short.schedule(shortTask);
      console.log(
        `attempt ${attempt}: scheduled crank — long task ${longTask} (${lsig.slice(
          0,
          8
        )}…), short task ${shortTask} (${ssig.slice(0, 8)}…), ` +
          `${INTERVAL_MS}ms x${ITERATIONS}. NO further client tx; polling status…`
      );

      // Poll-only: NO per-tick tx is sent. The native crank drives tick_crank.
      const deadline = Date.now() + MAX_POLL_MS;
      while (Date.now() < deadline) {
        lr = await long.programER.account.round.fetch(long.accounts.round);
        sr = await short.programER.account.round.fetch(short.accounts.round);
        if (lr.status === 2 && sr.status === 2) break;
        await sleep(POLL_MS);
      }
      // final read
      lr = await long.programER.account.round.fetch(long.accounts.round);
      sr = await short.programER.account.round.fetch(short.accounts.round);

      const liquidated = [lr, sr].filter(
        (r) => r.status === 2 && r.outcome === 2
      );
      console.log(
        `attempt ${attempt}: long=${lr.outcome}/${lr.status} short=${sr.outcome}/${sr.status}` +
          (liquidated.length
            ? "  <-- LIQUIDATED via NATIVE CRANK (zero client per-tick tx)"
            : "  (no liq this attempt; re-opening + re-scheduling)")
      );
      if (liquidated.length >= 1) {
        liqAttempt = attempt;
        break;
      }
    }

    // At least one side must have liquidated through the crank (outcome 2, payout 0).
    const liquidated = [lr, sr].filter(
      (r) => r.status === 2 && r.outcome === 2
    );
    assert.ok(
      liquidated.length >= 1,
      `no 2000x side liquidated via the native crank in ${ATTEMPTS} attempts — the live feed never moved ~0.04% inside the round window (calm market; rerun). last: long=${lr.outcome}/${lr.status} short=${sr.outcome}/${sr.status}`
    );
    for (const r of liquidated) {
      assert.equal(r.payout.toString(), "0", "a liquidation pays 0");
    }

    // The liquidated side(s) released their house lock fully (23.75 -> 0) and
    // conserved value: a payout-0 liq leaves house.locked == 0 and house.balance ==
    // (balance before that attempt's open) + the absorbed stake.
    for (const side of [long, short]) {
      const r = side === long ? lr : sr;
      if (!(r.status === 2 && r.outcome === 2)) continue;
      const balBefore = side === long ? longBalBeforeOpen : shortBalBeforeOpen;
      const h = await side.programER.account.houseBalance.fetch(side.till);
      assert.equal(
        h.locked.toString(),
        "0",
        "liquidated side's house lock fully released"
      );
      assert.equal(
        h.balance.toString(),
        (balBefore + BigInt(STAKE)).toString(),
        "house balance gained exactly the stake on a payout-0 liq (value conserved)"
      );
    }

    console.log(
      `self-driving-liq: liquidated on attempt ${liqAttempt} via the NATIVE CRANK — ` +
        `NO keeper loop, zero client per-tick tx. final long=${lr.outcome}/${lr.status} short=${sr.outcome}/${sr.status}`
    );
  });
});
