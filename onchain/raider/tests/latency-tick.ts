// Task 10 — continuous-TICK ER latency (p50/p95).
//
// The continuous settler `tick` is the per-mark heartbeat a keeper sends on the ER.
// This measures its round-trip as the keeper actually experiences it: submit the
// ER `tick` and await `confirmed`, over >=30 back-to-back ticks on ONE open round.
//
// METHOD NOTE: unlike open/close (tests/latency.ts), a `tick` that does NOT fire is
// a no-op that writes nothing to the Round PDA, so an accountSubscribe("processed")
// would never notify. We therefore time submit -> `confirmed` (the rpc() promise),
// which is well-defined for a no-op tx. To keep every tick a no-op we open at LOW
// leverage (10x: a liq needs ~8% adverse, impossible across the ~15s measurement)
// on the default 60s build (the 60s cap is never reached in ~15s), so the round
// stays open for all samples. The crank path (`tick_crank`) has NO client round-trip
// at all — its cadence is the validator schedule interval (50ms-1s, Task 8) — so
// this client-tick latency is the keeper-path figure; the crank-path figure is the
// schedule interval.
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

const STAKE = 1_000_000;
const ASSET_BTC = 0; // multi-asset: 0 = BTC = BTC_FEED
const N = parseInt(process.env.LAT_TICK_N || "30", 10); // measured ticks
const WARMUP = 3; // discard the first few (cold-account loading)
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

describe("raider — continuous-tick ER latency (submit -> confirmed p50/p95)", function () {
  this.timeout(1_000_000);
  const funder = anchor.Wallet.local();
  const baseConn = new anchor.web3.Connection(BASE_RPC, {
    wsEndpoint: BASE_WS,
    commitment: "confirmed",
  });
  const baseProvider = new anchor.AnchorProvider(baseConn, funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  it(`measures ${N} back-to-back tick round-trips on one open round`, async () => {
    const conn = baseConn;
    const mint = await createMint(conn, funder.payer, funder.publicKey, null, 6);
    const [housePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("house2"), mint.toBuffer()], program.programId);
    const [feedRegistry] = PublicKey.findProgramAddressSync([Buffer.from("feeds")], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

    await program.methods.initHouse().accounts({
      authority: funder.publicKey, mint, house: housePda, vaultAuthority, vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    const HOUSE_FUND = 30_000_000;
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, funder.publicKey);
    await mintTo(conn, funder.payer, mint, funderAta.address, funder.publicKey, HOUSE_FUND);
    await program.methods.fundHouse(new BN(HOUSE_FUND)).accounts({
      funder: funder.publicKey, mint, house: housePda, funderToken: funderAta.address,
      vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc({ skipPreflight: true });

    const session = Keypair.generate();
    await baseProvider.sendAndConfirm(new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey, toPubkey: session.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL,
      })));
    const sp = new anchor.AnchorProvider(baseConn, new anchor.Wallet(session), { commitment: "confirmed" });
    const pAs = new anchor.Program(idl, sp);
    const [player] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()], program.programId);
    const [round] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), session.publicKey.toBuffer()], program.programId);
    const till = deriveTill(program.programId, mint, session.publicKey); // per-session till (was the shared house)
    const ownerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, session.publicKey);
    await mintTo(conn, funder.payer, mint, ownerAta.address, funder.publicKey, 5_000_000);
    await pAs.methods.buyIn(new BN(5_000_000)).accounts({
      owner: session.publicKey, mint, player, ownerToken: ownerAta.address,
      vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });
    await pAs.methods.initRound().accounts({
      owner: session.publicKey, round, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });
    // slice_from_pot: carve this session's till off the master pot BEFORE delegating it.
    await pAs.methods.sliceFromPot(new BN(maxPayout(STAKE))).accounts({
      owner: session.publicKey, mint, master: housePda, till, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });
    await sendIxHttp(conn, pAs.methods.delegateSession().accounts({
      payer: session.publicKey, mint, player, house: till, round,
    }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]), session);

    // ER connection WITHOUT a wsEndpoint: we time via HTTP getSignatureStatuses
    // polling, NOT the rpc() WS-confirmation path. The ER's signature-subscription
    // stream trips the rpc-websockets v9 "Unknown action 'undefined'" bug (same one
    // sendIxHttp dodges on the base layer); the keeper only survives it by swallowing
    // errors. HTTP polling gives a clean, accurate submit -> first-status timing.
    const erConn = new anchor.web3.Connection(ER_RPC, { commitment: "confirmed" });
    const erProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(session), { commitment: "confirmed" });
    const programER = new anchor.Program(idl, erProvider);
    await sleep(8000); // delegation lands

    // Open LOW leverage (10x) so no tick fires during the measurement window.
    await programER.methods.open(ASSET_BTC, 1, 10, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts({
      player, house: till, round, mint, priceUpdate: BTC_FEED, registry: feedRegistry, playerAuthority: session.publicKey,
    }).signers([session]).rpc({ skipPreflight: true });

    // Build + sign + send a tick over HTTP, timing submit -> first signature status
    // (the player-relevant "it landed" signal). A FRESH blockhash per tick keeps each
    // tx's signature unique (tick has no nonce; a reused blockhash would dedup).
    async function tickTimed() {
      const tx = await programER.methods.tick().accounts({
        player, house: till, round, mint, priceUpdate: BTC_FEED, caller: session.publicKey,
      }).transaction();
      tx.feePayer = session.publicKey;
      tx.recentBlockhash = (await erConn.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(session);
      const t0 = Date.now(); // start timing AFTER blockhash fetch + sign: pure submit->land
      const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      for (let j = 0; j < 400; j++) {
        const st = (await erConn.getSignatureStatuses([sig])).value[0];
        if (st) {
          if (st.err) throw new Error("tick failed: " + JSON.stringify(st.err));
          return Date.now() - t0;
        }
        await sleep(25);
      }
      throw new Error("tick " + sig + " never landed");
    }

    const samples = [];
    for (let i = 0; i < N + WARMUP; i++) {
      const dt = await tickTimed();
      if (i >= WARMUP) samples.push(dt);
      if ((i + 1) % 10 === 0) process.stdout.write(`  tick ${i + 1}/${N + WARMUP}: ${dt}ms\n`);
    }
    // The round must still be OPEN (every tick was a no-op) — proves we measured
    // the heartbeat path, not a settle.
    const r = await programER.account.round.fetch(round);
    assert.equal(r.status, 1, "round stayed open across the measurement (all ticks no-op)");
    assert.ok(samples.length >= 30, `need >=30 samples, got ${samples.length}`);

    console.log("\nREGION NOTE: measured from this machine's network region (record honestly).");
    console.log(`=== CONTINUOUS-TICK ER LATENCY (submit -> confirmed), n=${samples.length} ===`);
    console.log(`  tick  p50=${pct(samples, 50)}ms  p95=${pct(samples, 95)}ms  min=${Math.min(...samples)}ms  max=${Math.max(...samples)}ms`);
  });
});
