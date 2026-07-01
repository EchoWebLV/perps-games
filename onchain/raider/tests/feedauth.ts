// SECURITY REGRESSION DRIVER — proves the unauthenticated-feed house-drain hole
// is CLOSED.
//
// Before the fix, `price_update` was a bare AccountInfo and `read_fresh`
// validated only publish_time staleness — never WHICH account it decoded. An
// attacker could pass any account whose bytes decode to a PriceUpdateV2 with an
// attacker-chosen price + fresh timestamp, force a Cap outcome, and drain the
// house. `force_close` being permissionless made any abandoned round drainable.
//
// The fix pins the feed account with `#[account(address = BTC_FEED)]` on
// OpenRound / CloseRound / ForceCloseRound. This driver proves an attacker
// cannot substitute a different account:
//
//   1. open() with a WRONG price_update (SystemProgram id) -> REJECTED (address
//      constraint, error 2012 / ConstraintAddress). The round NEVER opens.
//   2. open() legitimately (BTC_FEED) -> succeeds.
//   3. close() with a WRONG price_update -> REJECTED. The open round is NOT
//      settled against a forged price.
//   4. close() legitimately (BTC_FEED) -> succeeds, proving the SAME setup that
//      rejects the fake feed accepts the real one (no false-positive lock-out).
//
// Reuses the exact init_house -> fund_house -> buy_in -> init_round ->
// delegate_session setup the other ER drivers use.
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
const MAX_PAYOUT = 23_750_000;
const ASSET_BTC = 0; // multi-asset: 0 = BTC = BTC_FEED
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// init_house -> fund_house -> buy_in -> init_round -> delegate_session, all PDAs
// co-delegated to the ER. Returns everything open/close need. (Mirrors open.ts.)
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
  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
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
  return { session, mint, housePda, till, feedRegistry, vaultAuthority, vaultToken, playerPda, roundPda };
}

// The rejection must be the address pin (2012 / ConstraintAddress / "address")
// OR our defense-in-depth UntrustedFeed (6010) — anything BUT a successful
// settle against the forged price.
const FEED_REJECT = /ConstraintAddress|2012|0x7dc|address|UntrustedFeed|6010|0x177a/i;

describe("raider feed authentication — the unauthenticated-feed house-drain hole is CLOSED", function () {
  this.timeout(1_000_000);

  const funder = anchor.Wallet.local();
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }), funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  before(() => {
    console.log("base    :", BASE_RPC);
    console.log("ER      :", ER_RPC);
    console.log("BTC_FEED:", BTC_FEED.toBase58());
    console.log("program :", program.programId.toBase58());
  });

  it("rejects a FORGED price_update on open AND close, but accepts the real BTC feed", async () => {
    const sc = await buildScenario({ funder, baseProvider, program });
    console.log("session :", sc.session.publicKey.toBase58());

    const erProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(sc.session), { commitment: "confirmed" });
    const programER = new anchor.Program(idl, erProvider);

    // The attacker's fake "feed": a well-known account that is NOT the BTC feed.
    // (SystemProgram id — its address is not BTC_FEED, so the address pin must
    // reject it before any byte of it is decoded.)
    const FAKE_FEED = SystemProgram.programId;

    // --- 1) open() with a FORGED price_update -> REJECTED ---
    let openRejected = false, openErr = "";
    try {
      await programER.methods.open(ASSET_BTC, 1, 2000, new BN(STAKE), new BN(0), 0, 0, 0, 0).accounts({
        player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
        priceUpdate: FAKE_FEED, registry: sc.feedRegistry, playerAuthority: sc.session.publicKey,
      }).signers([sc.session]).rpc(); // preflight ON so the program code surfaces
    } catch (e) {
      openRejected = true;
      openErr = (e && e.toString()) || "";
    }
    assert.ok(openRejected, "[1] open with a forged feed MUST be rejected");
    assert.ok(FEED_REJECT.test(openErr),
      "[1] rejection must be the feed pin/registry check, got:\n  " + openErr.split("\n").slice(0, 6).join("\n  "));
    console.log("[1] open(forged feed) REJECTED:", openErr.split("\n")[0]);

    // The round must NOT have opened.
    const stillIdle = await programER.account.round.fetch(sc.roundPda);
    assert.equal(stillIdle.status, 0, "[1] round must stay idle after a rejected open");
    const houseAfterBadOpen = await programER.account.houseBalance.fetch(sc.till);
    assert.equal(houseAfterBadOpen.locked.toString(), "0", "[1] house must not lock on a rejected open");

    // --- 2) open() LEGITIMATELY (real BTC feed) -> succeeds ---
    await programER.methods.open(ASSET_BTC, 1, 100, new BN(STAKE), new BN(0), 0, 0, 0, 0).accounts({
      player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, registry: sc.feedRegistry, playerAuthority: sc.session.publicKey,
    }).signers([sc.session]).rpc({ skipPreflight: true });
    const opened = await programER.account.round.fetch(sc.roundPda);
    assert.equal(opened.status, 1, "[2] legitimate open must succeed");
    console.log(`[2] open(real BTC feed) OK: status=${opened.status} entry_raw=${opened.entryRaw.toString()}`);

    await sleep(2000);

    // --- 3) close() with a FORGED price_update -> REJECTED (open round NOT settled) ---
    let closeRejected = false, closeErr = "";
    try {
      await programER.methods.close().accounts({
        player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
        priceUpdate: FAKE_FEED, playerAuthority: sc.session.publicKey,
      }).signers([sc.session]).rpc();
    } catch (e) {
      closeRejected = true;
      closeErr = (e && e.toString()) || "";
    }
    assert.ok(closeRejected, "[3] close with a forged feed MUST be rejected");
    assert.ok(FEED_REJECT.test(closeErr),
      "[3] rejection must be the feed pin/owner check, got:\n  " + closeErr.split("\n").slice(0, 6).join("\n  "));
    console.log("[3] close(forged feed) REJECTED:", closeErr.split("\n")[0]);

    const stillOpen = await programER.account.round.fetch(sc.roundPda);
    assert.equal(stillOpen.status, 1, "[3] round must stay OPEN after a rejected close (not settled vs a forged price)");

    // --- 4) close() LEGITIMATELY (real BTC feed) -> succeeds ---
    await programER.methods.close().accounts({
      player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, playerAuthority: sc.session.publicKey,
    }).signers([sc.session]).rpc({ skipPreflight: true });
    const settled = await programER.account.round.fetch(sc.roundPda);
    assert.equal(settled.status, 2, "[4] legitimate close must settle the round");
    console.log(`[4] close(real BTC feed) OK: settled status=${settled.status} outcome=${settled.outcome} ` +
      `exit_raw=${settled.exitRaw.toString()}`);

    console.log("\nFEED-AUTH PROVEN: forged feed REJECTED on open AND close; real BTC feed ACCEPTED. Hole closed.");
  });
});
