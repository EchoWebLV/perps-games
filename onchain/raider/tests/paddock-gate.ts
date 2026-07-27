// GATE TEST — the assumption the whole paddock design rests on.
//
// A SHARED singleton Race PDA is delegated to the ER by the house. Each player
// separately, later, delegates their own Bettor + Ticket PDAs. If those cannot
// end up in the SAME validator's ephemeral state, the shared pari-mutuel pool is
// impossible and the design falls back to player-vs-house fixed odds.
//
// This half proves co-residency: all three delegated by two different payers at
// different times, then all three readable from the ER RPC. The co-WRITE proof
// needs place_bet (Task 7) and a program upgrade.
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/paddock.json");
const { BASE_RPC, BASE_WS, ER_RPC, ER_WS, BTC_FEED, VALIDATOR, sleep, sendIxHttp } =
  require("./helpers");
const { BN } = anchor;

const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const STRENGTHS = [1000, 1000, 1350, 1350, 1800, 1800, 2400, 3200];
const ENTRANTS = [0, 1, 2, 3, 4, 5, 6, 7];

const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];

describe("paddock GATE: multi-payer co-delegation", function () {
  this.timeout(1_000_000);

  const house = anchor.Wallet.local(); // ANCHOR_WALLET
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

  const player = Keypair.generate();
  let prog, playerProg, erProg, pid;
  let mint, bookPda, racePda, vaultAuthority, vaultToken;
  let bettorPda, ticketPda, playerAta;

  it("house creates the book and the shared race, then delegates the race", async () => {
    prog = mk(baseConn, house.payer);
    pid = prog.programId;
    console.log("      program :", pid.toBase58());
    console.log("      house   :", house.publicKey.toBase58());

    // Fund the player from the house — devnet airdrops are rate-limited.
    const fund = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: house.publicKey,
        toPubkey: player.publicKey,
        lamports: 0.06 * LAMPORTS_PER_SOL,
      })
    );
    await prog.provider.sendAndConfirm(fund);
    console.log("      player  :", player.publicKey.toBase58(), "(funded 0.06)");

    mint = await createMint(baseConn, house.payer, house.publicKey, null, 6);
    bookPda = pda([Buffer.from("book"), mint.toBuffer()], pid);
    racePda = pda([Buffer.from("race"), mint.toBuffer()], pid);
    vaultAuthority = pda([Buffer.from("vault"), mint.toBuffer()], pid);
    vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    console.log("      mint    :", mint.toBase58());

    await prog.methods
      .initBook()
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

    await prog.methods
      .initRace(ENTRANTS, STRENGTHS)
      .accounts({
        authority: house.publicKey,
        mint,
        race: racePda,
        priceUpdate: BTC_FEED,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const race = await prog.account.race.fetch(racePda);
    assert.equal(race.seq.toNumber(), 0);
    assert.equal(race.phase, 0);
    assert.ok(race.feed.equals(BTC_FEED), "feed not pinned");
    console.log("      race created, phase 0, feed pinned");

    // Delegate the SHARED race — house pays, names VALIDATOR.
    await sendIxHttp(
      baseConn,
      prog.methods
        .delegateRace()
        .accounts({ payer: house.publicKey, mint, race: racePda })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
      house.payer
    );
    console.log("      delegate_race sent, validator", VALIDATOR.toBase58());
  });

  it("a DIFFERENT payer, later, delegates their own bettor + ticket", async () => {
    await sleep(4000); // deliberately separate the two delegations in time

    playerProg = mk(baseConn, player);
    bettorPda = pda(
      [Buffer.from("bettor"), player.publicKey.toBuffer(), mint.toBuffer()],
      pid
    );
    ticketPda = pda(
      [Buffer.from("ticket"), player.publicKey.toBuffer(), mint.toBuffer()],
      pid
    );

    await playerProg.methods
      .join()
      .accounts({
        payer: player.publicKey,
        mint,
        bettor: bettorPda,
        ticket: ticketPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const ata = await getOrCreateAssociatedTokenAccount(
      baseConn,
      house.payer,
      mint,
      player.publicKey
    );
    playerAta = ata.address;
    await mintTo(baseConn, house.payer, mint, playerAta, house.payer, 5_000_000);

    await playerProg.methods
      .deposit(new BN(1_000_000))
      .accounts({
        owner: player.publicKey,
        mint,
        bettor: bettorPda,
        ownerToken: playerAta,
        vaultAuthority,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const b = await playerProg.account.bettor.fetch(bettorPda);
    assert.equal(b.balance.toNumber(), 1_000_000, "deposit did not credit");
    console.log("      player joined + deposited 1.0");

    await sendIxHttp(
      baseConn,
      playerProg.methods
        .delegateBettor()
        .accounts({ payer: player.publicKey, mint, bettor: bettorPda, ticket: ticketPda })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
      player
    );
    console.log("      delegate_bettor sent by a different payer, same validator");
  });

  it("ALL THREE land under the delegation program on L1", async () => {
    for (const [name, addr] of [
      ["race", racePda],
      ["bettor", bettorPda],
      ["ticket", ticketPda],
    ]) {
      let ok = false;
      for (let i = 0; i < 30; i++) {
        const info = await baseConn.getAccountInfo(addr);
        if (info && info.owner.equals(DELEGATION_PROGRAM)) {
          ok = true;
          break;
        }
        await sleep(1000);
      }
      assert.ok(ok, `${name} never became delegation-program owned`);
      console.log(`      ${name} delegated`);
    }
  });

  it("THE GATE: all three are co-resident in the SAME validator's rollup", async () => {
    erProg = mk(erConn, player);
    let race, bettor, ticket;
    let lastErr;
    for (let i = 0; i < 30; i++) {
      try {
        race = await erProg.account.race.fetch(racePda);
        bettor = await erProg.account.bettor.fetch(bettorPda);
        ticket = await erProg.account.ticket.fetch(ticketPda);
        break;
      } catch (e) {
        lastErr = e;
        await sleep(2000);
      }
    }
    assert.ok(race, "Race not readable from the ER: " + lastErr);
    assert.ok(bettor, "Bettor not readable from the ER: " + lastErr);
    assert.ok(ticket, "Ticket not readable from the ER: " + lastErr);

    assert.equal(bettor.balance.toNumber(), 1_000_000, "ER bettor balance wrong");
    assert.ok(race.feed.equals(BTC_FEED), "ER race feed wrong");
    assert.equal(ticket.raceSeq.toString(), "18446744073709551615", "ticket sentinel wrong");

    console.log("");
    console.log("      ==============================================");
    console.log("      GATE PASSED — shared Race + separately-delegated");
    console.log("      Bettor/Ticket are co-resident in one rollup.");
    console.log("      Shared pari-mutuel pool is viable.");
    console.log("      ==============================================");
  });
});
