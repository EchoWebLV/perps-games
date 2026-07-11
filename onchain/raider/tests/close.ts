// Task 8 driver: prove `close` on the MagicBlock ER.
//
// Full sequence: init_house -> fund_house -> buy_in -> init_round
//   -> delegate_session(player+house+round) -> open (ER)
//   -> sample a few ticks for price movement -> close (ER) -> fetch Round.
//
// Two LOAD-BEARING asserts:
//   1. CONSERVATION: player.balance + house.balance + house.locked is identical
//      BEFORE open and AFTER close (value is conserved across player+house; the
//      5% edge stays house-favorable inside the payout).
//   2. PROVABLE FAIRNESS: settleTs() is a BigInt integer MIRROR of settle.rs
//      (NOT the float @perps/engine — the float engine is off-by-one on
//      IEEE-754 boundaries; the Rust integer result is the correct one). We read
//      back the STORED round.{dir,lev,stake,entry_raw,exit_raw}, recompute with
//      settleTs, and assert it equals BOTH the on-chain round.payout AND the
//      credited player delta. The stored exit_raw makes this non-racy.
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
const { deriveTill, maxPayout } = require("./helpers");

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const BTC_FEED = new PublicKey(process.env.BTC_FEED || "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
const VALIDATOR = new PublicKey(process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const STAKE = 1_000_000; // 1 USDC
const MAX_PAYOUT = 23_750_000; // max_payout(1e6)
const ASSET_BTC = 0; // multi-asset: 0 = BTC = BTC_FEED
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// BigInt integer MIRROR of programs/raider/src/settle.rs — the proof anyone can
// recompute the payout from on-chain data alone. Truncating BigInt division
// mirrors Rust's i128/u128 integer division exactly (floors toward zero; all
// operands here are non-negative once equity is clamped). Outcome codes match
// Outcome::code(): 0 cashout / 1 cap / 2 liq.
// ---------------------------------------------------------------------------
const SCALE = 1_000_000n;
const EDGE_FP = 50_000n; // 0.05
const LIQ_FP = 200_000n; // 0.20
const CAP_FP = 25_000_000n; // 25.0

function equityFp(dir, lev, entryRaw, exitRaw) {
  // ratio = exit * SCALE / entry  (Rust: (exit as i128) * SCALE / (entry as i128))
  const ratio = (exitRaw * SCALE) / entryRaw;
  let eq = SCALE + dir * lev * (ratio - SCALE);
  if (eq < 0n) eq = 0n;
  return eq;
}
function terminal(eq) {
  if (eq <= LIQ_FP) return { code: 2, settled: 0n }; // Liq
  if (eq >= CAP_FP) return { code: 1, settled: CAP_FP }; // Cap
  return { code: 0, settled: eq }; // Cashout
}
function payoutFp(stake, settledEqFp) {
  // floor(stake * equity * (1 - edge)); u128 intermediates, two /SCALE divides
  return (stake * settledEqFp * (SCALE - EDGE_FP)) / SCALE / SCALE;
}
// Returns { outcome, payout } — both as the program would produce them.
function settleTs(dir, lev, stake, entryRaw, exitRaw) {
  const t = terminal(equityFp(BigInt(dir), BigInt(lev), BigInt(entryRaw), BigInt(exitRaw)));
  return { outcome: t.code, payout: payoutFp(BigInt(stake), t.settled) };
}

async function buildAndDelegate({ funder, baseProvider, program, houseFund, buyInAmount }) {
  const session = Keypair.generate();
  const conn = baseProvider.connection;

  await baseProvider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey, toPubkey: session.publicKey,
        lamports: 0.2 * LAMPORTS_PER_SOL,
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
  }).rpc({ skipPreflight: true });

  const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, funder.publicKey);
  await mintTo(conn, funder.payer, mint, funderAta.address, funder.publicKey, houseFund);
  await program.methods.fundHouse(new BN(houseFund)).accounts({
    funder: funder.publicKey, mint, house: housePda, funderToken: funderAta.address,
    vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc({ skipPreflight: true });

  const ownerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, session.publicKey);
  await mintTo(conn, funder.payer, mint, ownerAta.address, funder.publicKey, buyInAmount);
  await programAsSession.methods.buyIn(new BN(buyInAmount)).accounts({
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

  return { session, mint, housePda, till, feedRegistry, vaultAuthority, vaultToken, playerPda, roundPda };
}

describe("raider close (settle at exit, conserve, provably recomputable)", function () {
  this.timeout(1_000_000);

  const funder = anchor.Wallet.local();
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }), funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  before(() => {
    console.log("base    :", BASE_RPC);
    console.log("ER      :", ER_RPC);
    console.log("funder  :", funder.publicKey.toBase58());
  });

  it("close settles at exit, conserves value across player+house, and matches the BigInt recompute", async () => {
    const sc = await buildAndDelegate({
      funder, baseProvider, program,
      houseFund: 30_000_000, // 30 USDC: > one round's 23.75 pre-lock, headroom for a win
      buyInAmount: 5_000_000, // 5 USDC play balance
    });
    console.log("session :", sc.session.publicKey.toBase58());
    console.log("mint    :", sc.mint.toBase58());

    const erProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(sc.session), { commitment: "confirmed" });
    const programER = new anchor.Program(idl, erProvider);

    const sumBalances = async () => {
      const p = await programER.account.playerBalance.fetch(sc.playerPda);
      const h = await programER.account.houseBalance.fetch(sc.till);
      return BigInt(p.balance.toString()) + BigInt(h.balance.toString()) + BigInt(h.locked.toString());
    };

    // --- CONSERVATION baseline: measured BEFORE open ---
    const totalBefore = await sumBalances();
    console.log("total (player+house.balance+house.locked) BEFORE open:", totalBefore.toString());

    // open(BTC, long, 100x, 1 USDC) — settles against the TILL
    await programER.methods.open(ASSET_BTC, 1, 100, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts({
      player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, registry: sc.feedRegistry, playerAuthority: sc.session.publicKey,
    }).signers([sc.session]).rpc({ skipPreflight: true });

    const opened = await programER.account.round.fetch(sc.roundPda);
    const entryUsd = opened.entryRaw.toNumber() * Math.pow(10, -Math.abs(opened.entryExpo));
    console.log(`opened: entry_raw=${opened.entryRaw.toString()} (~$${entryUsd.toFixed(2)}) status=${opened.status}`);
    assert.equal(opened.status, 1);

    // NB: mid-open the running sum is intentionally NOT equal to totalBefore —
    // open debits the player's stake (escrowed in the round) and earmarks
    // house.locked WITHOUT moving house.balance, so the sum temporarily rises by
    // (max_payout - stake). Conservation is an end-to-end property: the stake is
    // credited to house.balance and the lock released only at close, so the sum
    // returns to totalBefore once the round is settled (asserted after close).

    const playerBeforeClose = BigInt((await programER.account.playerBalance.fetch(sc.playerPda)).balance.toString());

    // Sample a few ticks so the exit mark can differ from entry (price movement).
    // The feed advances ~1/s; a short wait lets BTC drift before we settle.
    await sleep(6000);

    // --- close on the ER ---
    await programER.methods.close().accounts({
      player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, playerAuthority: sc.session.publicKey,
    }).signers([sc.session]).rpc({ skipPreflight: true });

    const settled = await programER.account.round.fetch(sc.roundPda);
    const playerAfter = BigInt((await programER.account.playerBalance.fetch(sc.playerPda)).balance.toString());
    const playerDelta = playerAfter - playerBeforeClose; // what close credited

    const exitUsd = settled.exitRaw.toNumber() * Math.pow(10, -Math.abs(opened.entryExpo));
    const outName = ["cashout", "cap", "liq"][settled.outcome];
    console.log(`closed: status=${settled.status} outcome=${settled.outcome}(${outName}) ` +
      `exit_raw=${settled.exitRaw.toString()} (~$${exitUsd.toFixed(2)}) ` +
      `on-chain payout=${settled.payout.toString()} player credited=${playerDelta.toString()}`);
    console.log(`  ROUND PROOF: dir=${settled.dir} lev=${settled.lev} stake=${settled.stake.toString()} ` +
      `entry_raw=${settled.entryRaw.toString()} exit_raw=${settled.exitRaw.toString()}`);

    assert.equal(settled.status, 2, "round must be settled");
    assert.ok(settled.exitRaw.toNumber() > 0, "exit_raw must be recorded");
    assert.ok(settled.exitTs.toNumber() > 1_700_000_000, "exit_ts must be a sane unix time");

    // --- PROVABLE FAIRNESS: recompute from STORED on-chain data with the BigInt mirror ---
    const recomputed = settleTs(
      settled.dir, settled.lev, settled.stake.toNumber(),
      settled.entryRaw.toString(), settled.exitRaw.toString());
    console.log(`  settleTs() BigInt recompute: outcome=${recomputed.outcome} payout=${recomputed.payout.toString()}`);

    assert.equal(recomputed.payout.toString(), settled.payout.toString(),
      "BigInt settleTs payout must equal the on-chain round.payout (provable fairness)");
    assert.equal(recomputed.payout.toString(), playerDelta.toString(),
      "BigInt settleTs payout must equal the player's credited delta");
    assert.equal(recomputed.outcome, settled.outcome,
      "BigInt settleTs outcome must equal the stored on-chain outcome");

    // payout can never exceed the pre-locked worst case
    assert.ok(BigInt(settled.payout.toString()) <= BigInt(MAX_PAYOUT),
      "payout must not exceed the house pre-lock");

    // --- CONSERVATION: total identical before open and after close ---
    const totalAfter = await sumBalances();
    console.log("total (player+house.balance+house.locked) AFTER close:", totalAfter.toString());
    assert.equal(totalAfter.toString(), totalBefore.toString(),
      "value conserved across player+house (before open == after close)");

    // And the house lock is fully released.
    const house = await programER.account.houseBalance.fetch(sc.till);
    assert.equal(house.locked.toString(), "0", "house lock must be released after close");
  });
});
