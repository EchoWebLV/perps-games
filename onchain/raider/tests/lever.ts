// Phase 2 — lever parity proof: the owner-authority `lever` mid-round action changes
// leverage (terminal-first, then rebank+re-anchor), and the on-chain payout at close
// matches a BigInt sequence mirror of settle.rs recomputed from the ACTUAL observed
// on-chain prices.
//
// DETERMINISTIC (not market-dependent): the BigInt mirror computes the expected payout
// from the three prices the chain actually observed this run (open entry0, lever price =
// entry_raw after lever, exit), so whatever the feed does the on-chain settle must equal
// the mirror. The ONLY market assumption is that the 100x position does NOT liquidate
// within the ~3s test (a ~0.8% adverse move in 1.5s — essentially impossible). If that
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
const { deriveTill, maxPayout } = require("./helpers");
const ASSET_BTC = 0; // multi-asset: 0 = BTC = BTC_FEED

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

// --- BigInt sequence mirror of settle.rs (banked-aware) ---
// Truncating BigInt division mirrors Rust i128/u128 integer division. Outcome codes:
// 0 cashout / 1 cap / 2 liq. This is the BANKED-AWARE generalisation of the
// settleTs() mirror in tests/raider.ts: it walks the action sequence, applying the
// SAME terminal-first-then-rebank order the on-chain `lever`/`tick` use.
const SCALE = 1_000_000n,
  EDGE_FP = 50_000n,
  LIQ_FP = 200_000n,
  CAP_FP = 25_000_000n;
const rebankFp = (b, dir, lev, entry, price) =>
  b + dir * lev * ((price * SCALE) / entry - SCALE);
const equityFpB = (b, dir, lev, entry, exit) => {
  let e = SCALE + rebankFp(b, dir, lev, entry, exit);
  return e < 0n ? 0n : e;
};
const terminal = (eq) =>
  eq <= LIQ_FP
    ? { code: 2, settled: 0n }
    : eq >= CAP_FP
    ? { code: 1, settled: CAP_FP }
    : { code: 0, settled: eq };
const payoutFp = (stake, eq) =>
  (stake * eq * (SCALE - EDGE_FP)) / SCALE / SCALE;
function settleSeq(stake, dir0, lev0, entry0, actions, exitRaw) {
  let b = 0n,
    dir = BigInt(dir0),
    lev = BigInt(lev0),
    entry = BigInt(entry0);
  for (const a of actions) {
    const t = terminal(equityFpB(b, dir, lev, entry, BigInt(a.priceRaw)));
    if (t.code !== 0)
      return { outcome: t.code, payout: payoutFp(BigInt(stake), t.settled) };
    b = rebankFp(b, dir, lev, entry, BigInt(a.priceRaw));
    entry = BigInt(a.priceRaw);
    if (a.kind === "flip") dir = BigInt(a.dir);
    else if (a.kind === "lever") lev = BigInt(a.lev);
  }
  const t = terminal(equityFpB(b, dir, lev, entry, BigInt(exitRaw)));
  return { outcome: t.code, payout: payoutFp(BigInt(stake), t.settled) };
}

describe("raider — lever mid-round parity (terminal-first rebank, BigInt sequence mirror)", function () {
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

  it("open long 100x -> lever(500) -> close: lev changes, stays open, payout == BigInt sequence mirror", async () => {
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

    // Fund the house comfortably over one round's max-payout pre-lock (cap=25 USDC).
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
    // HTTP-confirm the heavy delegate CPI (WS confirmation is flaky for this tx).
    await sendIxHttp(
      conn,
      pAs.methods
        .delegateSession()
        .accounts({
          payer: session.publicKey,
          mint,
          player: playerPda,
          house: till,
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

    // ---- open long 100x ----
    await programER.methods
      .open(ASSET_BTC, 1, 100, new BN(STAKE), new BN(0), 0, 0, 0, 0)
      .accounts({
        player: playerPda,
        house: till,
        round: roundPda,
        mint,
        priceUpdate: BTC_FEED,
        registry: feedRegistry,
        playerAuthority: session.publicKey,
      })
      .signers([session])
      .rpc({ skipPreflight: true });
    const o = await programER.account.round.fetch(roundPda);
    assert.equal(o.status, 1, "round open after open");
    assert.equal(o.dir, 1, "opened long");
    assert.equal(o.lev, 100, "opened at 100x");
    const entry0 = BigInt(o.entryRaw.toString());

    await sleep(1500);
    // ---- lever up to 500x ----
    await programER.methods
      .lever(500)
      .accounts({
        player: playerPda,
        house: till,
        round: roundPda,
        mint,
        priceUpdate: BTC_FEED,
        playerAuthority: session.publicKey,
      })
      .signers([session])
      .rpc({ skipPreflight: true });
    const f = await programER.account.round.fetch(roundPda);
    assert.equal(f.lev, 500, "lev changed to 500");
    assert.equal(f.dir, 1, "dir unchanged (lever does not flip)");
    assert.equal(f.status, 1, "still open after lever (no liq)");
    const leverPrice = BigInt(f.entryRaw.toString());

    await sleep(1500);
    // ---- close ----
    await programER.methods
      .close()
      .accounts({
        player: playerPda,
        house: till,
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
      100,
      entry0,
      [{ kind: "lever", lev: 500, priceRaw: leverPrice }],
      exitRaw
    );
    assert.equal(
      s.payout.toString(),
      expected.payout.toString(),
      "on-chain lever payout == BigInt sequence mirror"
    );
    assert.equal(
      s.outcome,
      expected.outcome,
      "on-chain lever outcome == mirror"
    );
    console.log(
      `lever parity OK: entry0=${entry0} lever=${leverPrice} exit=${exitRaw} payout=${s.payout} (mirror ${expected.payout})`
    );
  });
});
