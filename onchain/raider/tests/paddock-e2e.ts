// PADDOCK END-TO-END — the full loop on devnet.
//
// Two independent wallets bet into ONE shared pari-mutuel pool, the crank runs
// the market -> racing -> settled -> next-race state machine, the winner's payout
// matches a BigInt mirror of book.rs to the unit, rake reaches L1 via a bare
// commit (no undelegation), and a bettor exits to L1 and withdraws real tokens.
//
// Uses a fresh 6-decimal test mint rather than wSOL, matching tests/deposit.ts —
// raider already proves the wSOL path; this driver's job is the shared pool.
//
// The crank is driven MANUALLY here. race_crank is permissionless by design, so
// this is a legitimate caller, and it makes the cycle deterministic instead of
// dependent on MagicBlock's scheduler escrow being funded. schedule_race_crank
// is asserted separately.
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/paddock.json");
const { BASE_RPC, BASE_WS, ER_RPC, ER_WS, BTC_FEED, VALIDATOR, sleep, sendIxHttp } =
  require("./helpers");
const {
  settlePool,
  payoutOf,
  deriveBook,
  deriveRace,
  deriveVault,
  deriveBettor,
  deriveTicket,
} = require("./paddock-helpers");
const { BN } = anchor;

const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const STRENGTHS = [1000, 1000, 1350, 1350, 1800, 1800, 2400, 3200];
const ENTRANTS = [0, 1, 2, 3, 4, 5, 6, 7];
const CAR_A = 0; // weakest
const CAR_B = 7; // strongest
const STAKE_A = 300_000;
const STAKE_B = 700_000;
const DEPOSIT = 2_000_000;

describe("paddock E2E: shared pool, crank cycle, exact payout", function () {
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

  const kpA = Keypair.generate();
  const kpB = Keypair.generate();
  let pid, mint, bookPda, racePda, vaultAuthority, vaultToken;
  let house1, houseER, aER, bER, aBase;
  let bettorA, bettorB, ticketA, ticketB, ataA, ataB;
  let bettingSeq, observedTotal, observedPools;

  async function fireCrank() {
    try {
      await sendIxHttp(
        erConn,
        houseER.methods.raceCrank().accounts({ race: racePda, priceUpdate: BTC_FEED }),
        house.payer
      );
    } catch (e) {
      // Expected while the phase has not expired, or while no price has landed
      // inside the anti-grinding band at phase_ends_ts.
    }
  }

  // race_crank is permissionless. Fire it until the phase actually moves.
  async function crankUntilPhase(target, maxSecs) {
    for (let i = 0; i < maxSecs; i++) {
      const r = await houseER.account.race.fetch(racePda);
      if (r.phase === target) return r;
      await fireCrank();
      await sleep(1000);
    }
    const r = await houseER.account.race.fetch(racePda);
    throw new Error(`phase ${target} not reached in ${maxSecs}s (stuck at ${r.phase})`);
  }

  // A market that is merely OPEN is not enough — `before()` takes longer than
  // MARKET_SECS, so the very first market is already expired and the next crank
  // locks it out from under the bets. Wait for one with real runway left.
  async function waitForFreshMarket(minSecsLeft, maxSecs) {
    for (let i = 0; i < maxSecs; i++) {
      const r = await houseER.account.race.fetch(racePda);
      const now = Math.floor(Date.now() / 1000);
      if (r.phase === 0 && r.phaseEndsTs.toNumber() - now > minSecsLeft) return r;
      await fireCrank();
      await sleep(1000);
    }
    throw new Error(`no market with >${minSecsLeft}s runway within ${maxSecs}s`);
  }

  before(async () => {
    house1 = mk(baseConn, house.payer);
    houseER = mk(erConn, house.payer);
    pid = house1.programId;
    console.log("      program:", pid.toBase58());

    const fund = new anchor.web3.Transaction();
    for (const kp of [kpA, kpB]) {
      fund.add(
        SystemProgram.transfer({
          fromPubkey: house.publicKey,
          toPubkey: kp.publicKey,
          lamports: 0.06 * LAMPORTS_PER_SOL,
        })
      );
    }
    await house1.provider.sendAndConfirm(fund);

    mint = await createMint(baseConn, house.payer, house.publicKey, null, 6);
    bookPda = deriveBook(pid, mint);
    racePda = deriveRace(pid, mint);
    vaultAuthority = deriveVault(pid, mint);
    vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    bettorA = deriveBettor(pid, kpA.publicKey, mint);
    bettorB = deriveBettor(pid, kpB.publicKey, mint);
    ticketA = deriveTicket(pid, kpA.publicKey, mint);
    ticketB = deriveTicket(pid, kpB.publicKey, mint);
    aER = mk(erConn, kpA);
    bER = mk(erConn, kpB);
    aBase = mk(baseConn, kpA);
    console.log("      mint   :", mint.toBase58());

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

    await sendIxHttp(
      baseConn,
      house1.methods
        .delegateRace()
        .accounts({ payer: house.publicKey, mint, book: bookPda, race: racePda })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
      house.payer
    );

    for (const [kp, bettor, ticket] of [
      [kpA, bettorA, ticketA],
      [kpB, bettorB, ticketB],
    ]) {
      const prog = mk(baseConn, kp);
      await prog.methods
        .join()
        .accounts({
          payer: kp.publicKey,
          mint,
          bettor,
          ticket,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const ata = await getOrCreateAssociatedTokenAccount(
        baseConn,
        house.payer,
        mint,
        kp.publicKey
      );
      if (kp === kpA) ataA = ata.address;
      else ataB = ata.address;
      await mintTo(baseConn, house.payer, mint, ata.address, house.payer, 5_000_000);
      await prog.methods
        .deposit(new BN(DEPOSIT))
        .accounts({
          owner: kp.publicKey,
          mint,
          bettor,
          ownerToken: ata.address,
          vaultAuthority,
          vaultToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      await sendIxHttp(
        baseConn,
        prog.methods
          .delegateBettor()
          .accounts({ payer: kp.publicKey, mint, book: bookPda, bettor, ticket })
          .remainingAccounts([
            { pubkey: VALIDATOR, isSigner: false, isWritable: false },
          ]),
        kp
      );
    }

    for (const pdaAddr of [racePda, bettorA, bettorB, ticketA, ticketB]) {
      for (let i = 0; i < 30; i++) {
        const info = await baseConn.getAccountInfo(pdaAddr);
        if (info && info.owner.equals(DELEGATION_PROGRAM)) break;
        await sleep(1000);
      }
    }
    console.log("      book + race + 2 bettors delegated");
  });

  it("arms the native crank via ScheduleTask", async () => {
    await sendIxHttp(
      erConn,
      houseER.methods
        .scheduleRaceCrank(new BN(Date.now() % 1e9), new BN(1000), new BN(300))
        .accounts({
          magicProgram: MAGIC_PROGRAM,
          payer: house.publicKey,
          race: racePda,
          priceUpdate: BTC_FEED,
        }),
      house.payer
    );
    console.log("      schedule_race_crank accepted");
  });

  it("two separately-delegated wallets bet into ONE shared pool concurrently", async () => {
    const r0 = await waitForFreshMarket(8, 150);
    bettingSeq = r0.seq.toNumber();

    // Concurrent — also the write-contention check. A lost update shows as a
    // short `total`.
    await Promise.all([
      sendIxHttp(
        erConn,
        aER.methods.placeBet(CAR_A, new BN(STAKE_A)).accounts({
          payer: kpA.publicKey,
          mint,
          race: racePda,
          bettor: bettorA,
          ticket: ticketA,
        }),
        kpA
      ),
      sendIxHttp(
        erConn,
        bER.methods.placeBet(CAR_B, new BN(STAKE_B)).accounts({
          payer: kpB.publicKey,
          mint,
          race: racePda,
          bettor: bettorB,
          ticket: ticketB,
        }),
        kpB
      ),
    ]);

    const r = await houseER.account.race.fetch(racePda);
    assert.equal(r.seq.toNumber(), bettingSeq, "race rolled mid-bet; rerun");
    assert.equal(r.pools[CAR_A].toNumber(), STAKE_A, "A's stake missing");
    assert.equal(r.pools[CAR_B].toNumber(), STAKE_B, "B's stake missing");
    assert.equal(
      r.total.toNumber(),
      STAKE_A + STAKE_B,
      "lost update under concurrent writes"
    );
    assert.deepEqual(
      [...r.seed],
      new Array(32).fill(0),
      "seed must not exist while bets are open"
    );
    // Capture what actually landed. The settle mirror runs against OBSERVED
    // state, not assumed constants — otherwise a missed bet shows up as a
    // settlement-math failure and hides its real cause.
    observedTotal = r.total.toNumber();
    observedPools = r.pools.map((p) => p.toNumber());
    console.log(`      pool: ${STAKE_A} on car ${CAR_A}, ${STAKE_B} on car ${CAR_B}`);
  });

  it("the crank locks the market and the seed appears only then", async () => {
    const r = await crankUntilPhase(1, 120);
    assert.notDeepEqual(
      [...r.seed],
      new Array(32).fill(0),
      "seed still zero after lock"
    );
    const orderSorted = [...r.order].sort((a, b) => a - b);
    assert.deepEqual(orderSorted, [0, 1, 2, 3, 4, 5, 6, 7], "order is not a permutation");
    console.log(`      locked, winner = car ${r.order[0]}`);
  });

  it("settles with a multiplier matching the JS mirror exactly", async () => {
    const r = await crankUntilPhase(2, 120);
    const rec = r.history[bettingSeq % 32];
    assert.equal(rec.seq.toNumber(), bettingSeq, "history slot holds the wrong race");

    const winner = rec.winner;
    const expected = settlePool(observedTotal, observedPools[winner]);

    assert.equal(
      rec.multFp.toString(),
      expected.multFp.toString(),
      `mult mismatch for winner car ${winner}`
    );
    assert.equal(
      r.rakeAccrued.toString(),
      expected.rake.toString(),
      "rake_accrued does not match the mirror"
    );
    console.log(
      `      settled: winner ${winner}, mult ${rec.multFp.toString()}, rake ${r.rakeAccrued.toString()}`
    );
  });

  it("the winner claims exactly the mirrored payout", async () => {
    // Roll to the next race so claim's `race_seq != race.seq` guard passes.
    await crankUntilPhase(0, 120);

    const r = await houseER.account.race.fetch(racePda);
    const rec = r.history[bettingSeq % 32];
    const winner = rec.winner;

    if (observedPools[winner] === 0) {
      assert.equal(rec.multFp.toNumber(), 0, "unbacked winner must pay 0");
      console.log("      nobody backed the winner — house took the pool");
      return;
    }

    const [kp, prog, bettor, ticket, stake] =
      winner === CAR_A
        ? [kpA, aER, bettorA, ticketA, observedPools[CAR_A]]
        : [kpB, bER, bettorB, ticketB, observedPools[CAR_B]];

    const pre = await prog.account.bettor.fetch(bettor);
    await sendIxHttp(
      erConn,
      prog.methods
        .claim()
        .accounts({ payer: kp.publicKey, mint, race: racePda, bettor, ticket }),
      kp
    );
    const post = await prog.account.bettor.fetch(bettor);
    const gained = BigInt(post.balance.toString()) - BigInt(pre.balance.toString());
    const want = payoutOf(stake, BigInt(rec.multFp.toString()));
    assert.equal(gained.toString(), want.toString(), "claim did not match the mirror");
    console.log(`      claimed ${gained.toString()} (mirror: ${want.toString()})`);
  });

  it("commit_race lands state on L1 WITHOUT undelegating", async () => {
    const erRace = await houseER.account.race.fetch(racePda);
    await sendIxHttp(
      erConn,
      houseER.methods.commitRace().accounts({ payer: house.publicKey, race: racePda }),
      house.payer
    );

    let l1Seq = null;
    for (let i = 0; i < 40; i++) {
      const info = await baseConn.getAccountInfo(racePda);
      if (info && info.data.length >= 48) {
        // Race layout: 8 disc, 32 mint, then u64 seq.
        l1Seq = info.data.readBigUInt64LE(8 + 32);
        if (l1Seq >= BigInt(erRace.seq.toString())) break;
      }
      await sleep(2000);
    }
    assert.ok(
      l1Seq !== null && l1Seq >= BigInt(erRace.seq.toString()),
      `commit did not land on L1 (saw ${l1Seq}, want >= ${erRace.seq})`
    );

    const info = await baseConn.getAccountInfo(racePda);
    assert.ok(
      info.owner.equals(DELEGATION_PROGRAM),
      "commit_race UNDELEGATED the Race — betting would stop"
    );

    // Still ER-writable afterwards.
    const after = await houseER.account.race.fetch(racePda);
    assert.ok(after, "Race unreadable in the ER after commit");
    console.log(`      committed seq ${l1Seq}, still delegated + ER-live`);
  });

  it("a bettor exits to L1 and withdraws real tokens", async () => {
    const pre = await getAccount(baseConn, ataA);
    await sendIxHttp(
      erConn,
      aER.methods
        .exitBettor()
        .accounts({ payer: kpA.publicKey, mint, bettor: bettorA, ticket: ticketA }),
      kpA
    );
    let owned = null;
    for (let i = 0; i < 40; i++) {
      const info = await baseConn.getAccountInfo(bettorA);
      if (info && info.owner.equals(pid)) {
        owned = info;
        break;
      }
      await sleep(2000);
    }
    assert.ok(owned, "bettor never undelegated back to the program");

    const bal = await aBase.account.bettor.fetch(bettorA);
    await aBase.methods
      .withdraw(bal.balance)
      .accounts({
        owner: kpA.publicKey,
        mint,
        bettor: bettorA,
        ownerToken: ataA,
        vaultAuthority,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    const post = await getAccount(baseConn, ataA);
    assert.ok(post.amount > pre.amount, "withdraw moved no tokens");

    console.log("");
    console.log("      ==============================================");
    console.log("      E2E PASSED — full loop proven on devnet");
    console.log("      ==============================================");
  });
});
