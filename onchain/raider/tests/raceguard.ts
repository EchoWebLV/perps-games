// Phase 2 — Task 7: flip-after-settle race guard (DETERMINISTIC, clock-driven).
//
// Requires the `test-short-deadline` build (MAX_ROUND_SECS = 8) deployed. Open LOW
// leverage (10x) so the round does not terminate on price; wait past the 8s deadline;
// then `force_close` (permissionless, deadline-gated) settles the round at the current
// equity and flips status -> 2. We then attempt a mid-round `flip(-1)` against the now
// SETTLED round and assert it is REJECTED with NoOpenRound (code 6003) — proving a
// stale action can never mutate an already-settled round (the keeper/owner race guard).
//
// NoOpenRound is the 4th RaiderError variant => Anchor code 6003 (confirmed against
// target/idl/raider.json). The rejection regex matches the name OR the exact code.
//
// Reuses the EXACT single-session ER setup proven in tests/flip.ts (mint/house/
// buy_in/init_round/delegate via sendIxHttp HTTP-poll + BASE_WS pin).
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

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
// Pin the base-layer WS endpoint. web3.js auto-derives the WS URL from BASE_RPC, but
// some HTTP providers (e.g. Helius) serve a signature-subscription stream that
// rpc-websockets v9 cannot parse ("Unknown action 'undefined'"), which makes Anchor's
// .rpc() throw even though the tx lands. Pinning a known-good public devnet WS keeps
// Anchor's confirmation path working while HTTP sends go to whatever BASE_RPC is.
const BASE_WS = process.env.BASE_WS || "wss://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const BTC_FEED = new PublicKey(
  process.env.BTC_FEED || "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"
);
const VALIDATOR = new PublicKey(
  process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAKE = 1_000_000; // 1 USDC

// Send + confirm a built Anchor instruction via HTTP polling ONLY (no WS). The
// base-layer `delegate_session` CPI is heavy and its WebSocket confirmation
// intermittently trips a web3.js bug that wraps the WS failure in a malformed
// SendTransactionError ("Unknown action 'undefined'") even though the tx itself lands.
// We bypass the WS path here: build, sign, sendRawTransaction, then poll
// getSignatureStatuses until confirmed.
async function sendIxHttp(conn, methodBuilder, signer) {
  const tx = await methodBuilder.transaction();
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (
      st &&
      (st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized")
    ) {
      if (st.err)
        throw new Error("tx " + sig + " failed: " + JSON.stringify(st.err));
      return sig;
    }
    await sleep(1000);
  }
  throw new Error("tx " + sig + " not confirmed within 60s");
}

describe("raider — flip-after-settle race guard (NoOpenRound)", function () {
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

  it("open 10x -> wait past 8s -> force_close settles -> flip(-1) REJECTED with NoOpenRound", async () => {
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

    // Fund the house comfortably over one 10x round's max-payout pre-lock.
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

    const erConn = new anchor.web3.Connection(ER_RPC, {
      wsEndpoint: ER_WS,
      commitment: "confirmed",
    });
    const erProvider = new anchor.AnchorProvider(
      erConn,
      new anchor.Wallet(session),
      { commitment: "confirmed" }
    );
    const programER = new anchor.Program(idl, erProvider);
    // Wait for the delegation to land before opening the round in-rollup.
    await sleep(8000);

    // ---- open long 10x (low lev: will not terminate on price within the window) ----
    await programER.methods
      .open(1, 10, new BN(STAKE))
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
    assert.equal(
      o.lev,
      10,
      "opened at 10x (determinism: 10x cannot liq/cap in 8s)"
    );

    // ---- wait past the 8s short deadline, then permissionlessly force_close ----
    await sleep(10_000); // > 8s short deadline
    await programER.methods
      .forceClose()
      .accounts({
        player: playerPda,
        house: housePda,
        round: roundPda,
        mint,
        priceUpdate: BTC_FEED,
        caller: session.publicKey,
      })
      .signers([session])
      .rpc({ skipPreflight: true });
    const settled = await programER.account.round.fetch(roundPda);
    assert.equal(settled.status, 2, "force_close settled the round");

    // ---- attempt a mid-round flip on the SETTLED round: MUST be rejected ----
    // We OBSERVE the rejection via simulate() rather than .rpc(): the ER's WS
    // confirmation path intermittently wraps results in a malformed
    // SendTransactionError ("Unknown action 'undefined'") that masks the real
    // program error (the same web3.js/rpc-websockets v9 bug sendIxHttp dodges for
    // delegate_session). A simulation runs the program against the same SETTLED
    // round and returns the program logs directly, so the NoOpenRound (6003) abort
    // is surfaced deterministically — no WS in the path.
    const flipTx = await programER.methods
      .flip(-1)
      .accounts({
        player: playerPda,
        house: housePda,
        round: roundPda,
        mint,
        priceUpdate: BTC_FEED,
        playerAuthority: session.publicKey,
      })
      .transaction();
    flipTx.feePayer = session.publicKey;
    flipTx.recentBlockhash = (
      await erConn.getLatestBlockhash("confirmed")
    ).blockhash;
    // Legacy-Transaction overload: simulateTransaction(tx, signers?) — no config arg.
    const sim = await erConn.simulateTransaction(flipTx, [session]);
    const rejected = !!sim.value.err;
    const err =
      JSON.stringify(sim.value.err || null) +
      " " +
      (sim.value.logs || []).join(" ");
    assert.ok(rejected, "flip after settle MUST be rejected");
    // NoOpenRound is RaiderError variant #4 => Anchor code 6003 (target/idl/raider.json).
    // The program logs the error name; 6003 is its custom-program-error code (0x1773).
    assert.ok(
      /NoOpenRound|6003|0x1773/i.test(err),
      "rejection must be NoOpenRound (6003), got: " +
        err.split("\n").slice(0, 4).join(" ")
    );
    console.log("raceguard: flip after settle REJECTED (NoOpenRound)");
  });
});
