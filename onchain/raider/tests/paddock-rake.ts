// PADDOCK RAKE SWEEP — the house collects, exactly once, on devnet.
//
// paddock-e2e.ts proves rake ACCRUES and reaches L1 via `commit_race`. It stops
// there: nothing credited the house. This driver is the other half — sweep_rake
// turning the committed cumulative counter into `book.balance`, and withdraw_rake
// pulling the real tokens out of the vault.
//
// THE INVARIANT UNDER TEST: every unit of rake is credited exactly once, ever, no
// matter how many times the sweep is called, in what order, or how stale L1's view
// of `rake_accrued` is. `book.rs` proves that over arbitrary orderings in pure
// Rust (every_unit_of_race_rake_reaches_the_house_exactly_once); this file proves
// the on-chain shell around it against the real rollup, where the staleness is
// real and not simulated:
//
//   * a sweep before any race has run              -> credits 0
//   * rake accrues in the ROLLUP, no commit        -> sweep credits 0 (stale L1)
//   * commit, then sweep                            -> credits the whole counter
//   * sweep again, immediately                      -> credits 0
//   * commit again with no new rake, sweep          -> credits 0
//   * a SECOND race's rake                          -> credited once, and only
//                                                      after its commit lands
//   * withdraw, then sweep again                    -> credits 0 (the mark is a
//                                                      watermark, not a balance)
//
// Fresh 6-decimal test mint, same as paddock-e2e.ts. The crank is driven MANUALLY
// and the scheduler is deliberately NOT armed for this race, so nothing advances
// the rollup between an ER read and the commit that follows it — the staleness in
// this test is the staleness the test intends, not a race with a background task.
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
  deriveBook,
  deriveRace,
  deriveVault,
  deriveBettor,
  deriveTicket,
} = require("./paddock-helpers");
const { BN } = anchor;

const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const STRENGTHS = [1000, 1000, 1350, 1350, 1800, 1800, 2400, 3200];
const ENTRANTS = [0, 1, 2, 3, 4, 5, 6, 7];
const CAR = 3;
const STAKE = 400_000;
const DEPOSIT = 2_000_000;

describe("paddock rake: the house collects, exactly once", function () {
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

  // A second wallet, used ONLY to fire the sweep. It is not the book authority
  // and owns nothing in the book beyond its own bet — proof the sweep really is
  // permissionless, rather than merely un-gated in a context the house signs.
  const kpA = Keypair.generate();
  let pid, mint, bookPda, racePda, vaultAuthority, vaultToken;
  let house1, houseER, aBase, aER;
  let bettorA, ticketA, ataA, houseAta;

  // L1's Race is owned by the DELEGATION program once delegated, so Anchor's
  // `program.account.race.fetch` refuses it ("Account does not belong to this
  // program"). Decode the raw bytes with the same coder instead — exactly what
  // sweep_rake does on chain.
  //
  // GOTCHA: the key is "race", lower-case, NOT the IDL's "Race". anchor-ts runs
  // convertIdlToCamelCase over the IDL inside the Program constructor, so the
  // coder is keyed by the camelCased name while `program.rawIdl` keeps the
  // original. "Race" throws `Account not found: Race`.
  async function readL1Race() {
    const info = await baseConn.getAccountInfo(racePda);
    if (!info) return null;
    return house1.coder.accounts.decode("race", info.data);
  }
  const readBook = () => house1.account.book.fetch(bookPda);
  const bn = (x) => BigInt(x.toString());

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

  // A market that is merely OPEN is not enough — setup outruns MARKET_SECS, so
  // the first market is already expired and the next crank locks it out from
  // under the bet. Wait for one with real runway left.
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

  // Bet, then crank a full market -> racing -> settled cycle. Returns the rake
  // the ROLLUP now shows (cumulative) and what the JS mirror says this race
  // should have added, computed from the pool that actually landed.
  async function runOneRaceWithABet() {
    const before = await houseER.account.race.fetch(racePda);
    const rakeBefore = bn(before.rakeAccrued);

    const r0 = await waitForFreshMarket(8, 180);
    const seq = r0.seq.toNumber();
    await sendIxHttp(
      erConn,
      aER.methods.placeBet(CAR, new BN(STAKE)).accounts({
        payer: kpA.publicKey,
        mint,
        race: racePda,
        bettor: bettorA,
        ticket: ticketA,
      }),
      kpA
    );

    const bet = await houseER.account.race.fetch(racePda);
    assert.equal(bet.seq.toNumber(), seq, "race rolled mid-bet; rerun");
    const total = bet.total.toNumber();
    const pools = bet.pools.map((p) => p.toNumber());
    assert.equal(total, STAKE, "bet did not land");

    const settled = await crankUntilPhase(2, 180);
    const rec = settled.history[seq % 32];
    assert.equal(rec.seq.toNumber(), seq, "history slot holds the wrong race");

    const mirror = settlePool(total, pools[rec.winner]);
    const rakeAfter = bn(settled.rakeAccrued);
    assert.equal(
      (rakeAfter - rakeBefore).toString(),
      mirror.rake.toString(),
      "this race's rake does not match the book.rs mirror"
    );
    console.log(
      `      race ${seq}: total ${total}, winner car ${rec.winner}, ` +
        `rake +${mirror.rake} -> rollup cumulative ${rakeAfter}`
    );
    return { seq, cumulative: rakeAfter, added: mirror.rake };
  }

  // Land the rollup's Race on L1 and wait until the committed rake reaches
  // `want`. Returns L1's decoded view.
  async function commitAndWaitForRake(want) {
    await sendIxHttp(
      erConn,
      houseER.methods.commitRace().accounts({ payer: house.publicKey, race: racePda }),
      house.payer
    );
    for (let i = 0; i < 40; i++) {
      const r = await readL1Race();
      if (r && bn(r.rakeAccrued) >= want) return r;
      await sleep(2000);
    }
    const r = await readL1Race();
    throw new Error(
      `commit did not land rake ${want} on L1 (saw ${r ? r.rakeAccrued : "no account"})`
    );
  }

  // The sweep itself. `signer` defaults to kpA — the NON-authority — because
  // that is the interesting case.
  async function sweep(signer = kpA) {
    const prog = signer === kpA ? aBase : house1;
    await prog.methods
      .sweepRake()
      .accounts({ payer: signer.publicKey, mint, book: bookPda, race: racePda })
      .rpc();
    return readBook();
  }

  before(async () => {
    house1 = mk(baseConn, house.payer);
    houseER = mk(erConn, house.payer);
    pid = house1.programId;
    console.log("      program:", pid.toBase58());
    console.log("      house  :", house.publicKey.toBase58());

    await house1.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: house.publicKey,
          toPubkey: kpA.publicKey,
          lamports: 0.06 * LAMPORTS_PER_SOL,
        })
      )
    );

    mint = await createMint(baseConn, house.payer, house.publicKey, null, 6);
    bookPda = deriveBook(pid, mint);
    racePda = deriveRace(pid, mint);
    vaultAuthority = deriveVault(pid, mint);
    vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    bettorA = deriveBettor(pid, kpA.publicKey, mint);
    ticketA = deriveTicket(pid, kpA.publicKey, mint);
    aBase = mk(baseConn, kpA);
    aER = mk(erConn, kpA);
    console.log("      mint   :", mint.toBase58());
    console.log("      sweeper:", kpA.publicKey.toBase58(), "(NOT the authority)");

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
    console.log("      book + race created (race NOT yet delegated)");
  });

  it("sweeps a fresh, un-delegated book to zero without erroring", async () => {
    // Also the only point in the run where L1's Race is owned by the PROGRAM
    // rather than the delegation program. sweep_rake reads it as raw bytes
    // either way, so this covers the un-delegated shape of the same code path.
    const raceInfo = await baseConn.getAccountInfo(racePda);
    assert.ok(raceInfo.owner.equals(pid), "race should still be program-owned here");

    const b = await sweep();
    assert.equal(b.balance.toString(), "0", "credited rake that never existed");
    assert.equal(b.locked.toString(), "0", "advanced the mark with no rake");
    console.log("      pre-delegation sweep: balance 0, mark 0");
  });

  it("delegates the race and one bettor, funded and ready to bet", async () => {
    await sendIxHttp(
      baseConn,
      house1.methods
        .delegateRace()
        .accounts({ payer: house.publicKey, mint, book: bookPda, race: racePda })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
      house.payer
    );

    await aBase.methods
      .join()
      .accounts({
        payer: kpA.publicKey,
        mint,
        bettor: bettorA,
        ticket: ticketA,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const ata = await getOrCreateAssociatedTokenAccount(
      baseConn,
      house.payer,
      mint,
      kpA.publicKey
    );
    ataA = ata.address;
    await mintTo(baseConn, house.payer, mint, ataA, house.payer, 5_000_000);
    await aBase.methods
      .deposit(new BN(DEPOSIT))
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

    // The house's own token account, where withdraw_rake will land the money.
    const hAta = await getOrCreateAssociatedTokenAccount(
      baseConn,
      house.payer,
      mint,
      house.publicKey
    );
    houseAta = hAta.address;

    await sendIxHttp(
      baseConn,
      aBase.methods
        .delegateBettor()
        .accounts({ payer: kpA.publicKey, mint, book: bookPda, bettor: bettorA, ticket: ticketA })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
      kpA
    );

    // 90 polls, and transient RPC failures are swallowed rather than aborting:
    // public devnet 429s this suite hard, and a rejected getAccountInfo says
    // nothing about whether the delegation landed. A 30-poll window was not
    // always enough under rate limiting.
    for (const pdaAddr of [racePda, bettorA, ticketA]) {
      let ok = false;
      for (let i = 0; i < 90; i++) {
        try {
          const info = await baseConn.getAccountInfo(pdaAddr);
          if (info && info.owner.equals(DELEGATION_PROGRAM)) {
            ok = true;
            break;
          }
        } catch (e) {
          // rate-limited; retry
        }
        await sleep(1000);
      }
      assert.ok(ok, `${pdaAddr.toBase58()} never delegated`);
    }
    console.log("      race + bettor delegated, vault funded");
  });

  let race1;

  it("rake accrues in the ROLLUP and L1 still shows nothing", async () => {
    race1 = await runOneRaceWithABet();
    assert.ok(race1.cumulative > 0n, "no rake accrued — the race settled empty");

    const l1 = await readL1Race();
    assert.equal(
      l1.rakeAccrued.toString(),
      "0",
      "L1 saw rake without a commit — the staleness this file tests is not real"
    );
    console.log(`      rollup rake ${race1.cumulative}, L1 rake 0 (no commit yet)`);
  });

  it("a sweep against a stale L1 view credits nothing", async () => {
    // The under-crediting case, and the one that matters: crediting against a
    // lagging commit must be safe, because the sweep cannot know how far behind
    // it is. It is safe precisely because the counter is cumulative — the
    // shortfall is picked up whole by the next sweep, never lost.
    const b = await sweep();
    assert.equal(b.balance.toString(), "0", "credited rake L1 has not seen");
    assert.equal(b.locked.toString(), "0", "advanced the mark past L1's view");
    console.log("      stale sweep: balance 0, mark 0 (rollup is ahead)");
  });

  it("commit_race then sweep credits the rake, and the mark follows it", async () => {
    const l1 = await commitAndWaitForRake(race1.cumulative);
    const committed = bn(l1.rakeAccrued);

    const b = await sweep(); // fired by kpA — the NON-authority
    assert.equal(b.balance.toString(), committed.toString(), "house was not credited");
    assert.equal(b.locked.toString(), committed.toString(), "mark did not follow");
    console.log(
      `      committed ${committed} -> book.balance ${b.balance} book.locked ${b.locked} ` +
        `(swept by a non-authority wallet)`
    );
  });

  it("a second sweep in a row credits nothing", async () => {
    // The headline case. Same committed value, same mark, zero delta.
    const before = await readBook();
    const b = await sweep();
    assert.equal(b.balance.toString(), before.balance.toString(), "DOUBLE-CREDITED");
    assert.equal(b.locked.toString(), before.locked.toString(), "mark moved on a no-op");

    // And a third, for good measure — it is a watermark, not a toggle.
    const c = await sweep();
    assert.equal(c.balance.toString(), before.balance.toString(), "DOUBLE-CREDITED");
    console.log(`      swept 3x total, balance still ${c.balance}`);
  });

  it("a re-commit that carries no new rake is a no-op sweep", async () => {
    // A stale commit in the other direction: L1's view is refreshed but the
    // number is unchanged, so there is nothing to credit.
    const before = await readBook();
    await commitAndWaitForRake(bn(before.locked));
    const b = await sweep();
    assert.equal(b.balance.toString(), before.balance.toString(), "re-commit re-credited");
    assert.equal(b.locked.toString(), before.locked.toString(), "mark drifted on a re-commit");
    console.log(`      re-commit + sweep: balance unchanged at ${b.balance}`);
  });

  it("a SECOND race's rake is credited exactly once, and only once it lands", async () => {
    const before = await readBook();
    const race2 = await runOneRaceWithABet();
    assert.ok(race2.added > 0n, "second race added no rake");

    // Still stale — the new rake exists only in the rollup.
    const stale = await sweep();
    assert.equal(
      stale.balance.toString(),
      before.balance.toString(),
      "credited the second race before its commit landed"
    );

    const l1 = await commitAndWaitForRake(race2.cumulative);
    const committed = bn(l1.rakeAccrued);
    const b = await sweep();
    assert.equal(
      b.balance.toString(),
      committed.toString(),
      "cumulative credit does not equal the cumulative counter"
    );
    assert.equal(
      (bn(b.balance) - bn(before.balance)).toString(),
      race2.added.toString(),
      "the second race's rake was not credited exactly once"
    );

    const again = await sweep();
    assert.equal(again.balance.toString(), b.balance.toString(), "DOUBLE-CREDITED");
    console.log(
      `      race 1 + race 2 = ${b.balance} credited; +${race2.added} for race 2, ` +
        `and a repeat sweep added nothing`
    );
  });

  it("only the book authority can withdraw the rake", async () => {
    const b = await readBook();
    let threw = null;
    try {
      await aBase.methods
        .withdrawRake(b.balance)
        .accounts({
          authority: kpA.publicKey,
          mint,
          book: bookPda,
          authorityToken: ataA,
          vaultAuthority,
          vaultToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, "a non-authority drained the house's rake");
    const after = await readBook();
    assert.equal(after.balance.toString(), b.balance.toString(), "balance moved anyway");
    console.log(`      non-authority withdraw rejected: ${String(threw).split("\n")[0]}`);
  });

  it("withdraw_rake moves exactly the credited rake out of the vault", async () => {
    const b = await readBook();
    const amount = bn(b.balance);
    assert.ok(amount > 0n, "nothing to withdraw — the sweep never credited");

    const preHouse = await getAccount(baseConn, houseAta);
    const preVault = await getAccount(baseConn, vaultToken);

    await house1.methods
      .withdrawRake(b.balance)
      .accounts({
        authority: house.publicKey,
        mint,
        book: bookPda,
        authorityToken: houseAta,
        vaultAuthority,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postHouse = await getAccount(baseConn, houseAta);
    const postVault = await getAccount(baseConn, vaultToken);
    const after = await readBook();

    assert.equal(
      (postHouse.amount - preHouse.amount).toString(),
      amount.toString(),
      "house token account did not gain exactly the credited rake"
    );
    assert.equal(
      (preVault.amount - postVault.amount).toString(),
      amount.toString(),
      "vault did not shed exactly the credited rake"
    );
    assert.equal(after.balance.toString(), "0", "balance not drained");
    assert.equal(
      after.locked.toString(),
      b.locked.toString(),
      "withdrawing rewound the high-water mark"
    );
    console.log(`      withdrew ${amount} to the house ATA; mark held at ${after.locked}`);
  });

  it("sweeping after a withdrawal still credits nothing", async () => {
    // The mark is a watermark on the COUNTER, not a mirror of the balance.
    // If withdrawing had rewound it, this sweep would pay the same rake twice.
    const before = await readBook();
    const b = await sweep();
    assert.equal(b.balance.toString(), "0", "re-credited rake that was already paid out");
    assert.equal(b.locked.toString(), before.locked.toString(), "mark moved");
    console.log("      post-withdrawal sweep: balance still 0");
  });

  it("withdrawing more than the credited balance fails", async () => {
    let threw = null;
    try {
      await house1.methods
        .withdrawRake(new BN(1))
        .accounts({
          authority: house.publicKey,
          mint,
          book: bookPda,
          authorityToken: houseAta,
          vaultAuthority,
          vaultToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, "withdrew rake the book never credited");

    console.log("");
    console.log("      ==============================================");
    console.log("      RAKE SWEEP PASSED — credited exactly once");
    console.log("      ==============================================");
  });
});
