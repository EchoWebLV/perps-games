// LIQ-OUTCOME DRIVER — exercises a REAL on-chain liquidation against the live
// Lazer BTC feed (closing the coverage gap the audit flagged).
//
// CAP (+1.25% equity ceiling at this leverage) is NOT deterministically forceable
// against the live feed without a price backdoor we deliberately do NOT add — so
// CAP stays covered by the Rust unit test (settle::tests::cap_clamp) plus the
// `payout.min(max_payout)` clamp in settle_round. LIQ, by contrast, IS forceable:
// at RMAX=2000 the liquidation threshold (equity <= 0.2) is crossed by only a
// ~-0.04% adverse move from entry, and a LONG and a SHORT opened at the same mark
// are mirror images — whichever way BTC ticks, at least one side is underwater.
//
// Strategy: open a 2000x LONG and a 2000x SHORT (two fresh sessions), let the
// feed tick, close both. Assert AT LEAST ONE settles outcome=liq(2), payout=0,
// with house.locked released and value conserved. Retry the whole round a few
// times if a freak near-zero tick spares both sides.
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
  ER_RPC,
  ER_WS,
  BTC_FEED,
  VALIDATOR,
  sleep,
  deriveTill,
  maxPayout,
} = require("./helpers");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const STAKE = 1_000_000; // 1 USDC
const MAX_PAYOUT = 23_750_000;
const RMAX = 2000;
const ASSET_BTC = 0; // multi-asset: 0 = BTC = BTC_FEED

// init_house -> fund_house -> buy_in -> init_round -> delegate_session.
async function buildScenario({ funder, baseProvider, program }) {
  const session = Keypair.generate();
  const conn = baseProvider.connection;
  await baseProvider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey, toPubkey: session.publicKey,
        lamports: 0.03 * LAMPORTS_PER_SOL,
      })));
  const sessionProvider = new anchor.AnchorProvider(
    conn, new anchor.Wallet(session), { commitment: "confirmed" });
  const programAsSession = new anchor.Program(idl, sessionProvider);
  const mint = await createMint(conn, funder.payer, funder.publicKey, null, 6);
  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], program.programId);
  const till = deriveTill(program.programId, mint, session.publicKey); // per-session till (was the shared house)
  const [feedRegistry] = PublicKey.findProgramAddressSync([Buffer.from("feeds")], program.programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
  const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
  const [playerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()], program.programId);
  const [roundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), session.publicKey.toBuffer()], program.programId);

  await program.methods.initHouse().accounts({
    authority: funder.publicKey, mint, house: housePda, vaultAuthority, vaultToken,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).signers([funder.payer]).rpc({ skipPreflight: true });

  const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, funder.publicKey);
  await mintTo(conn, funder.payer, mint, funderAta.address, funder.publicKey, MAX_PAYOUT);
  await program.methods.fundHouse(new BN(MAX_PAYOUT)).accounts({
    funder: funder.publicKey, mint, house: housePda, funderToken: funderAta.address,
    vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
  }).signers([funder.payer]).rpc({ skipPreflight: true });

  const ownerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, session.publicKey);
  await mintTo(conn, funder.payer, mint, ownerAta.address, funder.publicKey, 5_000_000);
  await programAsSession.methods.buyIn(new BN(5_000_000)).accounts({
    owner: session.publicKey, mint, player: playerPda, ownerToken: ownerAta.address,
    vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });

  await programAsSession.methods.initRound().accounts({
    owner: session.publicKey, round: roundPda, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });

  // slice_from_pot: carve this session's till off the master pot BEFORE delegating it.
  await programAsSession.methods.sliceFromPot(new BN(maxPayout(STAKE))).accounts({
    owner: session.publicKey, mint, master: housePda, till, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });

  await programAsSession.methods.delegateSession().accounts({
    payer: session.publicKey, mint, player: playerPda, house: till, round: roundPda,
  }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
    .rpc({ skipPreflight: true });

  const targets = { player: playerPda, house: till, round: roundPda };
  let flipped = {};
  for (let i = 0; i < 25; i++) {
    flipped = {};
    for (const [name, pda] of Object.entries(targets)) {
      const info = await conn.getAccountInfo(pda);
      flipped[name] = info && info.owner.toBase58() === DELEGATION_PROGRAM.toBase58();
    }
    if (flipped.player && flipped.house && flipped.round) break;
    await sleep(1000);
  }
  assert.ok(flipped.player && flipped.house && flipped.round, `not all delegated: ${JSON.stringify(flipped)}`);

  const erProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
    new anchor.Wallet(session), { commitment: "confirmed" });
  const programER = new anchor.Program(idl, erProvider);
  return { session, mint, housePda, till, feedRegistry, vaultAuthority, vaultToken, playerPda, roundPda, programER };
}

// Sum the three ledgers (conservation check) on a given scenario's ER view.
async function sumLedgers(sc) {
  const p = await sc.programER.account.playerBalance.fetch(sc.playerPda);
  const h = await sc.programER.account.houseBalance.fetch(sc.till);
  return BigInt(p.balance.toString()) + BigInt(h.balance.toString()) + BigInt(h.locked.toString());
}

describe("raider LIQ outcome — a real on-chain liquidation at RMAX against the live feed", function () {
  this.timeout(1_000_000);

  const funder = anchor.Wallet.local();
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }), funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  before(() => {
    console.log("base    :", BASE_RPC);
    console.log("ER      :", ER_RPC);
    console.log("program :", program.programId.toBase58());
  });

  it(`opens a 2000x LONG and a 2000x SHORT; at least one LIQUIDATES (payout=0, lock released, conserved)`, async () => {
    const ATTEMPTS = 3;
    // equity <= LIQ_FP (0.2) at 2000x needs a move of >= (1 - 0.2)/2000 = 0.04%.
    // We wait until the LIVE feed has drifted past a safe margin (0.06%) from the
    // entry mark in EITHER direction, which guarantees the adverse side is below
    // the liq band, then close. Reading the live mark off the ER avoids a blind
    // fixed sleep that (as observed) can leave a sub-0.01% move = no liquidation.
    const LIQ_MOVE = 0.0004; // 0.04% threshold
    const SAFE_MOVE = 0.0006; // wait for 0.06% so we're comfortably past it
    const MAX_WAIT_MS = 120_000;
    let liquidatedOnce = false;

    // Read the current BTC raw price off the ER feed account (same bytes the
    // program decodes). Mirrors price.rs parse: skip disc(8)+wa(32)+tag, feed_id(32).
    const erConn = new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
    async function liveRaw() {
      const info = await erConn.getAccountInfo(BTC_FEED);
      const d = info.data;
      let off = 8 + 32;
      const tag = d[off]; off += 1;
      if (tag === 0) off += 1;
      off += 32; // feed_id
      return Number(d.readBigInt64LE(off));
    }

    for (let attempt = 1; attempt <= ATTEMPTS && !liquidatedOnce; attempt++) {
      console.log(`\n--- attempt ${attempt}/${ATTEMPTS} ---`);
      // Two fresh, independent scenarios (own mint/house/player/round each).
      // Built SEQUENTIALLY to keep RPC pressure (and 429s) down.
      const scLong = await buildScenario({ funder, baseProvider, program });
      const scShort = await buildScenario({ funder, baseProvider, program });

      const totalLongBefore = await sumLedgers(scLong);
      const totalShortBefore = await sumLedgers(scShort);

      // Open both at ~the same mark: LONG 2000x and SHORT 2000x — each settles against its own TILL.
      await scLong.programER.methods.open(ASSET_BTC, 1, RMAX, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts({
        player: scLong.playerPda, house: scLong.till, round: scLong.roundPda, mint: scLong.mint,
        priceUpdate: BTC_FEED, registry: scLong.feedRegistry, playerAuthority: scLong.session.publicKey,
      }).signers([scLong.session]).rpc({ skipPreflight: true });
      await scShort.programER.methods.open(ASSET_BTC, -1, RMAX, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts({
        player: scShort.playerPda, house: scShort.till, round: scShort.roundPda, mint: scShort.mint,
        priceUpdate: BTC_FEED, registry: scShort.feedRegistry, playerAuthority: scShort.session.publicKey,
      }).signers([scShort.session]).rpc({ skipPreflight: true });
      const oL = await scLong.programER.account.round.fetch(scLong.roundPda);
      const oS = await scShort.programER.account.round.fetch(scShort.roundPda);
      console.log(`opened LONG 2000x entry=${oL.entryRaw.toString()} | SHORT 2000x entry=${oS.entryRaw.toString()}`);
      assert.equal(oL.status, 1); assert.equal(oS.status, 1);

      // Poll the live feed until it has drifted past SAFE_MOVE from BOTH entries
      // (so whichever side is adverse is firmly below the liq band), or time out.
      const entryL = oL.entryRaw.toNumber();
      const entryS = oS.entryRaw.toNumber();
      const t0 = Date.now();
      let lastRaw = entryL, moved = 0;
      while (Date.now() - t0 < MAX_WAIT_MS) {
        await sleep(4000);
        try { lastRaw = await liveRaw(); } catch (_) { continue; }
        const mL = Math.abs(lastRaw / entryL - 1);
        const mS = Math.abs(lastRaw / entryS - 1);
        moved = Math.min(mL, mS);
        console.log(`  live=${lastRaw} move-vs-LONG=${(mL * 100).toFixed(4)}% move-vs-SHORT=${(mS * 100).toFixed(4)}%`);
        if (moved >= SAFE_MOVE) break;
      }
      console.log(`  closing after ${(Date.now() - t0) / 1000}s; min-move ${(moved * 100).toFixed(4)}% ` +
        `(liq band crossed at ${(LIQ_MOVE * 100).toFixed(2)}%)`);

      // Close both.
      await scLong.programER.methods.close().accounts({
        player: scLong.playerPda, house: scLong.till, round: scLong.roundPda, mint: scLong.mint,
        priceUpdate: BTC_FEED, playerAuthority: scLong.session.publicKey,
      }).signers([scLong.session]).rpc({ skipPreflight: true });
      await scShort.programER.methods.close().accounts({
        player: scShort.playerPda, house: scShort.till, round: scShort.roundPda, mint: scShort.mint,
        priceUpdate: BTC_FEED, playerAuthority: scShort.session.publicKey,
      }).signers([scShort.session]).rpc({ skipPreflight: true });

      const sL = await scLong.programER.account.round.fetch(scLong.roundPda);
      const sS = await scShort.programER.account.round.fetch(scShort.roundPda);
      const nm = ["cashout", "cap", "liq"];
      console.log(`closed LONG  outcome=${sL.outcome}(${nm[sL.outcome]}) exit=${sL.exitRaw.toString()} payout=${sL.payout.toString()}`);
      console.log(`closed SHORT outcome=${sS.outcome}(${nm[sS.outcome]}) exit=${sS.exitRaw.toString()} payout=${sS.payout.toString()}`);

      // Inspect each side; the FIRST liquidated side is our load-bearing proof.
      for (const [label, sc, settled, totalBefore] of [
        ["LONG", scLong, sL, totalLongBefore],
        ["SHORT", scShort, sS, totalShortBefore],
      ]) {
        assert.equal(settled.status, 2, `${label} must be settled`);
        if (settled.outcome === 2) {
          liquidatedOnce = true;
          console.log(`>>> ${label} LIQUIDATED on-chain — asserting payout=0, lock released, conserved`);
          // payout = 0 on a liquidation.
          assert.equal(settled.payout.toString(), "0", `${label} liq payout must be 0`);
          // house lock fully released.
          const h = await sc.programER.account.houseBalance.fetch(sc.till);
          assert.equal(h.locked.toString(), "0", `${label} house.locked must release on liq`);
          // value conserved across player+house (before open == after close).
          const totalAfter = await sumLedgers(sc);
          assert.equal(totalAfter.toString(), totalBefore.toString(),
            `${label} value must be conserved across player+house`);
          // the player gained nothing (stake forfeited, payout 0).
          const player = await sc.programER.account.playerBalance.fetch(sc.playerPda);
          console.log(`    ${label} player.balance=${player.balance.toString()} house.locked=${h.locked.toString()} ` +
            `conserved total=${totalAfter.toString()}`);
        }
      }
      if (!liquidatedOnce) console.log("neither side liquidated this attempt (sub-0.04% feed move) — retrying");
    }

    assert.ok(liquidatedOnce,
      `no on-chain liquidation in ${ATTEMPTS} attempts — the feed moved < ~0.04% every time (unlikely; rerun)`);
    console.log("\nLIQ PROVEN: a real on-chain 2000x liquidation settled payout=0 with the house lock released and value conserved.");
  });
});
