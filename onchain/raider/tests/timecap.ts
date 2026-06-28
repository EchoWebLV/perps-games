// Phase 2 — Task 7: 60s time-cap proof (DETERMINISTIC, clock-driven not price-driven).
//
// Requires the `test-short-deadline` build (MAX_ROUND_SECS = 8) deployed. Open LOW
// leverage (10x) so the round can neither liquidate (needs a ~-8% move in 8s) nor
// cap (needs ~+240%) within the cap window — leaving TIME as the only terminal that
// fires. The permissionless keeper ticks the round; once `now >= deadline_ts` the
// program relabels the plain cashout to Time (settle_round, lib.rs) and settles at
// the CURRENT equity. We assert outcome === 3 (Time), payout > 0 (a non-liq cashout),
// status === 2, and that the house lock is released — i.e. no round escrows house
// capital past its deadline.
//
// Reuses the EXACT single-session ER setup proven in tests/flip.ts (mint/house/
// buy_in/init_round/delegate via sendIxHttp HTTP-poll + BASE_WS pin) and the
// permissionless keeper exported from tests/keeper.ts.
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
const { runKeeper } = require("./keeper");
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
  // delegate_session co-delegates 3 PDAs and is near the default 200k CU limit;
  // cold-account loading can push it over (ComputationalBudgetExceeded). Raise it
  // so the heavy delegate tx lands deterministically.
  tx.instructions.unshift(
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })
  );
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

describe("raider — 60s time-cap (deterministic clock terminal, outcome=Time)", function () {
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

  it("open 10x -> keeper ticks past the 8s cap -> settles outcome=3 (Time), payout>0, lock released", async () => {
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

    // ---- open long 10x: cannot liq (needs ~-8% in 8s) nor cap (needs ~+240%);
    //      the ONLY terminal that can fire in the cap window is TIME ----
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
    assert.equal(o.lev, 10, "opened at 10x");

    // House lock taken while the round is open (released only on settle).
    const lockedOpen = BigInt(
      (await programER.account.houseBalance.fetch(housePda)).locked.toString()
    );
    assert.ok(lockedOpen > 0n, "house lock taken while round open");

    // ---- run the permissionless keeper across the 8s cap window ----
    // 60 ticks * 300ms = ~18s of wall time, comfortably past the 8s deadline.
    const accounts = {
      player: playerPda,
      house: housePda,
      round: roundPda,
      mint,
      btcFeed: BTC_FEED,
    };
    const r = await runKeeper(programER, accounts, session, {
      intervalMs: 300,
      maxTicks: 60,
    });

    assert.equal(r.status, 2, "round settled");
    assert.equal(r.outcome, 3, "10x over the 8s cap settles as time");
    assert.ok(
      BigInt(r.payout.toString()) > 0n,
      "time settle pays the current (non-liq) equity"
    );
    const houseLocked = BigInt(
      (await programER.account.houseBalance.fetch(housePda)).locked.toString()
    );
    assert.equal(
      houseLocked.toString(),
      "0",
      "house lock released after time settle"
    );
    console.log(
      `timecap: outcome=${r.outcome}(time) payout=${r.payout} after the 8s cap`
    );
  });
});
