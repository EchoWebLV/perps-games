// Phase 2 — continuous-liquidation proof: the PERMISSIONLESS `tick` settler closes
// an underwater round on the ER without anyone choosing the outcome.
//
// Built on the SAME mint/house/session plumbing proven in tests/raider.ts
// (createMint -> init_house -> fund_house -> buy_in -> init_round ->
//  delegate_session -> ER provider -> open). It opens a 2000x LONG and a 2000x
// SHORT (each on its OWN mint/house so the two delegations are independent), so a
// move in EITHER direction puts exactly one side underwater. A keeper ticks both;
// whichever side crosses the ~0.04% liq band (any 2000x adverse move) is settled by
// `tick` with payout == 0. We assert the liquidated side settled via tick with
// payout 0, the house lock released to 0, and value conserved at the house.
//
// MARKET/DEADLINE NOTE: at 2000x a liq needs only a ~0.04% adverse move, but it
// must cross WITHIN the round's time-cap or `tick` settles `time` instead. On the
// default 60s build a ~0.04% move comfortably fits even in a calm market; on the
// test-short-deadline 8s build a sustained-calm market (where 0.04% needs ~30s)
// can time-cap every window — so each attempt re-opens a FRESH window (cheap, no
// re-delegation) and we retry up to LIQ_ATTEMPTS times. Tune MAX_TICKS to the
// deployed cap (see below).
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
const { runKeeper } = require("./keeper");

const {
  BASE_RPC,
  BASE_WS,
  ER_RPC,
  ER_WS,
  BTC_FEED,
  VALIDATOR,
  sleep,
  sendIxHttp,
} = require("./helpers");
const STAKE = 1_000_000;
// Keeper window per attempt + how many fresh windows to try. MAX_TICKS (@200ms each)
// MUST be sized to the DEPLOYED round time-cap so the keeper observes a full window
// (and re-opens AFTER it settles). Pick MAX_TICKS via env to match the build:
//   - test-short-deadline (8s):  MAX_TICKS=60   (60*200ms = 12s > 8s)
//   - default (60s):             MAX_TICKS=300  (300*200ms = 60s)
//   - test-long-deadline (180s): MAX_TICKS=900  (900*200ms = 180s)
// On a calm, mean-reverting feed a 2000x liq (needs only ~0.04% adverse) can take
// >60s of HELD-entry drift to cross, so the long-deadline build is what reliably
// liquidates today. NOTE: under-sizing MAX_TICKS leaves the round still open
// (status 1) when the loop re-opens → `RoundAlreadyOpen`; size it to the cap.
const MAX_TICKS = Number(process.env.MAX_TICKS || 250);
const ATTEMPTS = Number(process.env.LIQ_ATTEMPTS || 6);

describe("raider — continuous 2000x liquidation via tick (keeper-driven)", function () {
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

  it("opens long+short 2000x; the underwater side liquidates through tick (payout 0, lock released, conserved)", async () => {
    const conn = baseConn;

    // One independent mint + house PER SIDE. `delegate_session` co-delegates
    // player+house+round, and the HouseBalance PDA is shared across all rounds on a
    // mint — so two sessions on ONE mint would have the second `delegate_session`
    // try to re-delegate the already-delegated house (ExternalAccountDataModified).
    // Giving each side its own mint/house makes the two delegations independent
    // while preserving the proof: open LONG 2000x on house A and SHORT 2000x on
    // house B so EXACTLY ONE side is underwater on the next tick and must liquidate.
    //
    // Setup (mint/house/buy_in/delegate + the ~8s delegation wait) is the slow part
    // and is done for BOTH sides first; the `open` calls fire back-to-back AFTER, so
    // both rounds' 8s deadlines start fresh together. (If the two opens were ~25s
    // apart, the first round's time-cap would fire on the keeper's very first tick,
    // pre-empting the liquidation we're trying to observe.)
    async function setupSide(dir) {
      const mint = await createMint(
        conn,
        funder.payer,
        funder.publicKey,
        null,
        6
      );
      const [housePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("house"), mint.toBuffer()],
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
        .initHouse()
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

      // Fund this side's house for one 2000x round (>= 23.75 pre-lock).
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
      // Keep session funding small: it pays only fees (open/tick are cheap) and the
      // session keypair is ephemeral, so this SOL is not reclaimed after the run.
      await baseProvider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: funder.publicKey,
            toPubkey: session.publicKey,
            lamports: 0.05 * LAMPORTS_PER_SOL,
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
      // HTTP-confirm the delegate CPI (WS confirmation is flaky for this heavy tx).
      await sendIxHttp(
        conn,
        pAs.methods
          .delegateSession()
          .accounts({
            payer: session.publicKey,
            mint,
            player,
            house: housePda,
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
      // The `open` is deferred so both sides open together with fresh deadlines.
      const open = () =>
        programER.methods
          .open(dir, 2000, new BN(STAKE))
          .accounts({
            player,
            house: housePda,
            round,
            mint,
            priceUpdate: BTC_FEED,
            playerAuthority: session.publicKey,
          })
          .signers([session])
          .rpc({ skipPreflight: true });
      return {
        session,
        programER,
        housePda,
        open,
        accounts: { player, house: housePda, round, mint, btcFeed: BTC_FEED },
      };
    }

    // Run the two slow setups SEQUENTIALLY (not Promise.all). Each side's setup is a
    // chain of ~12 base-layer RPC calls (createMint/mintTo/fund/buy_in/delegate);
    // running both interleaved bursts the public devnet RPC past its per-method limit
    // ("429 Too many requests for a specific RPC call"). Serializing them keeps each
    // side's calls spaced. This does NOT weaken the proof: `open` is deferred (returned
    // as a thunk) and the two opens are still fired together below, so both rounds'
    // deadlines start fresh in lockstep regardless of when each side was delegated.
    const long = await setupSide(1);
    const short = await setupSide(-1);

    // `open` requires round.status != 1, so a SETTLED round (status 2) can be
    // re-opened — re-snapshotting a fresh entry + a fresh 8s deadline — WITHOUT any
    // re-delegation. We exploit that to retry across many fresh 8s windows: at 2000x
    // a liq needs only a ~0.04% adverse move, but in a calm market an 8s window may
    // not cross it (then the time-cap fires instead). Each cheap re-open is a new
    // window; the fast keeper catches the first window that DOES cross. This proves
    // the `tick` liquidation robustly without weakening the assert or touching the
    // deployed program. The lock/conservation asserts run on whichever attempt liqs.
    let lr,
      sr,
      liqAttempt = 0;
    // Per-side house snapshot taken on each attempt JUST BEFORE that attempt's open,
    // so the conservation check on the liquidating attempt is robust to value drift
    // from any prior time-settled attempts (house balance changes each settle).
    let longBalBeforeOpen, shortBalBeforeOpen;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const lh = await long.programER.account.houseBalance.fetch(long.housePda);
      const sh = await short.programER.account.houseBalance.fetch(
        short.housePda
      );
      longBalBeforeOpen = BigInt(lh.balance.toString());
      shortBalBeforeOpen = BigInt(sh.balance.toString());
      // House lock is free (0) before each open (prior round released it).
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

      // Each side's house pre-locked exactly one 2000x round's max-payout (23.75).
      const longLockedAfterOpen = BigInt(
        (
          await long.programER.account.houseBalance.fetch(long.housePda)
        ).locked.toString()
      );
      const shortLockedAfterOpen = BigInt(
        (
          await short.programER.account.houseBalance.fetch(short.housePda)
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

      // Drive both with the keeper until each settles (liq/cap, or time at the cap).
      [lr, sr] = await Promise.all([
        runKeeper(long.programER, long.accounts, long.session, {
          intervalMs: 200,
          maxTicks: MAX_TICKS,
        }),
        runKeeper(short.programER, short.accounts, short.session, {
          intervalMs: 200,
          maxTicks: MAX_TICKS,
        }),
      ]);

      const liquidated = [lr, sr].filter(
        (r) => r.status === 2 && r.outcome === 2
      );
      console.log(
        `attempt ${attempt}: long=${lr.outcome}/${lr.status} short=${sr.outcome}/${sr.status}` +
          (liquidated.length
            ? "  <-- LIQUIDATED via tick"
            : "  (no liq this attempt; re-opening)")
      );
      if (liquidated.length >= 1) {
        liqAttempt = attempt;
        break;
      }
    }

    // At least one side must have liquidated through tick (outcome 2, payout 0).
    const liquidated = [lr, sr].filter(
      (r) => r.status === 2 && r.outcome === 2
    );
    assert.ok(
      liquidated.length >= 1,
      `no 2000x side liquidated via tick in ${ATTEMPTS} attempts — the live feed never moved ~0.04% inside the round window (calm market; rerun, or use a longer-deadline build). last: long=${lr.outcome}/${lr.status} short=${sr.outcome}/${sr.status}`
    );
    for (const r of liquidated) {
      assert.equal(r.payout.toString(), "0", "a liquidation pays 0");
    }

    // The liquidated side(s) released their house lock fully (23.75 -> 0) and
    // conserved value: a payout-0 liq leaves house.locked == 0 and house.balance ==
    // (balance before that attempt's open) + the absorbed stake. (The winning side
    // may be time-settled this attempt.)
    for (const side of [long, short]) {
      const r = side === long ? lr : sr;
      if (!(r.status === 2 && r.outcome === 2)) continue;
      const balBefore = side === long ? longBalBeforeOpen : shortBalBeforeOpen;
      const h = await side.programER.account.houseBalance.fetch(side.housePda);
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
      `continuous-liq: liquidated on attempt ${liqAttempt}; final long=${lr.outcome}/${lr.status} short=${sr.outcome}/${sr.status}`
    );
  });
});
