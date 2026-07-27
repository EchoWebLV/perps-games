// PADDOCK CRANK LIVENESS — does the scheduled task actually FIRE?
//
// paddock-e2e.ts drives race_crank MANUALLY and asserts only that
// `schedule_race_crank` is ACCEPTED (the ScheduleTask CPI does not error).
// Acceptance is not execution. This probe answers the separate question the
// e2e deliberately left open: once armed, does MagicBlock's scheduler invoke
// race_crank on its interval with NO client transaction at all?
//
// The answer decides the product shape:
//   fires   -> races self-run; the client is a pure reader+bettor.
//   silent  -> a keeper process is a hard liveness dependency, and that is a
//              centralisation fact that belongs in the design before any
//              client code assumes autonomous races.
//
// METHOD: stand up a fresh book+race, delegate, arm the crank, then POLL ONLY.
// This file must never call race_crank — that would destroy the measurement.
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const {
  createMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/paddock.json");
const { BASE_RPC, BASE_WS, ER_RPC, ER_WS, BTC_FEED, VALIDATOR, sleep, sendIxHttp } =
  require("./helpers");
const { deriveBook, deriveRace, deriveVault } = require("./paddock-helpers");
const { BN } = anchor;

const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const STRENGTHS = [1000, 1000, 1350, 1350, 1800, 1800, 2400, 3200];
const ENTRANTS = [0, 1, 2, 3, 4, 5, 6, 7];

const WATCH_SECS = 150; // > MARKET_SECS + RACING_SECS, so a live crank must move twice
const PHASE_NAME = ["MARKET", "RACING", "SETTLED"];

describe("paddock crank liveness: does ScheduleTask actually execute?", function () {
  this.timeout(1_000_000);

  const house = anchor.Wallet.local();
  const baseConn = new anchor.web3.Connection(BASE_RPC, {
    commitment: "confirmed",
    wsEndpoint: BASE_WS,
  });
  const erConn = new anchor.web3.Connection(ER_RPC, {
    commitment: "confirmed",
    wsEndpoint: ER_WS,
  });
  const mk = (conn, kp) =>
    new anchor.Program(
      idl,
      new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" })
    );

  let pid, mint, bookPda, racePda, vaultAuthority, vaultToken, house1, houseER;

  before(async () => {
    house1 = mk(baseConn, house.payer);
    houseER = mk(erConn, house.payer);
    pid = house1.programId;
    console.log("      program:", pid.toBase58());

    mint = await createMint(baseConn, house.payer, house.publicKey, null, 6);
    bookPda = deriveBook(pid, mint);
    racePda = deriveRace(pid, mint);
    vaultAuthority = deriveVault(pid, mint);
    vaultToken = anchor.utils.token.associatedAddress({ mint, owner: vaultAuthority });
    console.log("      mint:", mint.toBase58());

    await house1.methods
      .initBook(VALIDATOR)
      .accounts({
        authority: house.publicKey,
        mint,
        book: bookPda,
        vaultAuthority,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await house1.methods
      .initRace(ENTRANTS, STRENGTHS)
      .accounts({
        authority: house.publicKey,
        mint,
        book: bookPda,
        race: racePda,
        priceUpdate: BTC_FEED,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await house1.methods
      .delegateRace()
      .accounts({ payer: house.publicKey, mint, book: bookPda, race: racePda })
      .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
      .rpc();
    console.log("      book + race delegated");
  });

  it("arms the crank and the scheduler drives the phase machine unattended", async () => {
    const t0 = await houseER.account.race.fetch(racePda);
    console.log(
      `      t=0   seq=${t0.seq} phase=${PHASE_NAME[t0.phase]} endsIn=${
        t0.phaseEndsTs.toNumber() - Math.floor(Date.now() / 1000)
      }s`
    );

    await sendIxHttp(
      erConn,
      houseER.methods
        .scheduleRaceCrank(new BN(Date.now() % 1e9), new BN(1000), new BN(WATCH_SECS + 60))
        .accounts({
          magicProgram: MAGIC_PROGRAM,
          payer: house.publicKey,
          race: racePda,
          priceUpdate: BTC_FEED,
        }),
      house.payer
    );
    console.log("      armed — 1000ms interval. NOT cranking from here on.");

    // Poll only. Any phase or seq movement can only have come from the scheduler.
    const seen = new Set([`${t0.seq}:${t0.phase}`]);
    let last = t0;
    for (let i = 1; i <= WATCH_SECS; i += 5) {
      await sleep(5000);
      const r = await houseER.account.race.fetch(racePda);
      const key = `${r.seq}:${r.phase}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`      t=${i}s  MOVED -> seq=${r.seq} phase=${PHASE_NAME[r.phase]}`);
      }
      last = r;
    }

    const moved = seen.size > 1;
    console.log(
      `      final: seq=${last.seq} phase=${PHASE_NAME[last.phase]} — ` +
        `${seen.size} distinct state(s) over ${WATCH_SECS}s`
    );
    console.log(
      moved
        ? "      VERDICT: scheduler FIRES. Races self-run; no keeper needed."
        : "      VERDICT: scheduler SILENT. A keeper is a hard liveness dependency."
    );

    assert.ok(
      moved,
      `race froze at seq=${last.seq} phase=${PHASE_NAME[last.phase]} for ${WATCH_SECS}s with the ` +
        `crank armed and no manual call — the scheduled task is NOT executing`
    );
  });
});
