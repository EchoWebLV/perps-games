// Phase 2 — flip parity proof: the owner-authority `flip` mid-round action reverses
// direction (terminal-first, then rebank+re-anchor), and the on-chain payout at close
// matches a BigInt sequence mirror of settle.rs recomputed from the ACTUAL observed
// on-chain prices.
//
// DETERMINISTIC (not market-dependent): the BigInt mirror computes the expected payout
// from the three prices the chain actually observed this run (open entry0, flip price =
// entry_raw after flip, exit), so whatever the feed does the on-chain settle must equal
// the mirror. The ONLY market assumption is that the 50x position does NOT liquidate
// within the ~3s test (a ~1.6% adverse move in 1.5s — essentially impossible). If that
// freak event happens, f.status would be 2 (settled) not 1 — re-run.
//
// Built on the SAME mint/house/session plumbing proven in tests/raider.ts and reusing
// the ER workarounds from tests/tick-liq.ts (BASE_WS pin + sendIxHttp for the heavy
// delegate_session tx). Single session (one mint/house/player/round).
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
  settleSeq,
} = require("./helpers");
const STAKE = 1_000_000; // 1 USDC

describe("raider — flip mid-round parity (terminal-first rebank, BigInt sequence mirror)", function () {
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

  it("open long 50x -> flip(-1) -> close: dir flips, stays open, payout == BigInt sequence mirror", async () => {
    const conn = baseConn;

    // ---- single-session setup (mint/house/buy_in/init_round/delegate) ----
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

    // Fund the house comfortably over one 50x round's max-payout pre-lock (23.75).
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
    await baseProvider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: session.publicKey,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        })
      )
    );
    const sp = new anchor.AnchorProvider(baseConn, new anchor.Wallet(session), {
      commitment: "confirmed",
    });
    const pAs = new anchor.Program(idl, sp);
    const [playerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()],
      program.programId
    );
    const [roundPda] = PublicKey.findProgramAddressSync(
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
        player: playerPda,
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
        round: roundPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ skipPreflight: true });
    // HTTP-confirm the heavy delegate CPI (WS confirmation is flaky for this tx).
    await sendIxHttp(
      conn,
      pAs.methods
        .delegateSession()
        .accounts({
          payer: session.publicKey,
          mint,
          player: playerPda,
          house: housePda,
          round: roundPda,
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
    // Wait for the delegation to land before opening the round in-rollup.
    await sleep(8000);

    // ---- open long 50x ----
    await programER.methods
      .open(1, 50, new BN(STAKE))
      .accounts({
        player: playerPda,
        house: housePda,
        round: roundPda,
        mint,
        priceUpdate: BTC_FEED,
        playerAuthority: session.publicKey,
      })
      .signers([session])
      .rpc({ skipPreflight: true });
    const o = await programER.account.round.fetch(roundPda);
    assert.equal(o.status, 1, "round open after open");
    assert.equal(o.dir, 1, "opened long");
    const entry0 = BigInt(o.entryRaw.toString());

    await sleep(1500);
    // ---- flip to short ----
    await programER.methods
      .flip(-1)
      .accounts({
        player: playerPda,
        house: housePda,
        round: roundPda,
        mint,
        priceUpdate: BTC_FEED,
        playerAuthority: session.publicKey,
      })
      .signers([session])
      .rpc({ skipPreflight: true });
    const f = await programER.account.round.fetch(roundPda);
    assert.equal(f.dir, -1, "dir flipped to short");
    assert.equal(f.status, 1, "still open after flip (low lev, no liq)");
    const flipPrice = BigInt(f.entryRaw.toString());

    await sleep(1500);
    // ---- close ----
    await programER.methods
      .close()
      .accounts({
        player: playerPda,
        house: housePda,
        round: roundPda,
        mint,
        priceUpdate: BTC_FEED,
        playerAuthority: session.publicKey,
      })
      .signers([session])
      .rpc({ skipPreflight: true });
    const s = await programER.account.round.fetch(roundPda);
    assert.equal(s.status, 2, "round settled after close");
    const exitRaw = BigInt(s.exitRaw.toString());

    const expected = settleSeq(
      STAKE,
      1,
      50,
      entry0,
      [{ kind: "flip", dir: -1, priceRaw: flipPrice }],
      exitRaw
    );
    assert.equal(
      s.payout.toString(),
      expected.payout.toString(),
      "on-chain flip payout == BigInt sequence mirror"
    );
    assert.equal(
      s.outcome,
      expected.outcome,
      "on-chain flip outcome == mirror"
    );
    console.log(
      `flip parity OK: entry0=${entry0} flip=${flipPrice} exit=${exitRaw} payout=${s.payout} (mirror ${expected.payout})`
    );
  });
});
