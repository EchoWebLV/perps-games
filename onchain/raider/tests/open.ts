// Task 7 driver: prove `open` on the MagicBlock ER.
//
//   init_house -> fund_house (>= max_payout(stake)) -> buy_in (player)
//   -> init_round -> delegate_session(player+house+round) -> open (on ER)
//
// Asserts after open:
//   round.status == 1, entry_raw > 0, entry_ts a sane recent unix time,
//   house.locked == max_payout(stake) == stake * 23.75,
//   player.balance dropped by exactly `stake`.
//
// Plus a SECOND self-contained scenario: an under-funded house (free balance <
// max_payout) makes `open` REJECT with HouseUndercapitalized.
//
// Uses a FRESH session owner keypair per scenario (funded from ANCHOR_WALLET) so
// player/house/round start fresh + program-owned each run. House is mint-scoped,
// and each scenario uses a fresh mint, so houses never collide across runs.
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

const STAKE = 1_000_000; // 1 USDC (6 decimals)
const MAX_PAYOUT = 23_750_000; // max_payout(1e6) = stake * 25 * 0.95 = 23.75 USDC
const ASSET_BTC = 0; // multi-asset: 0 = BTC = BTC_FEED
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared scenario builder: fresh mint + session, run init_house -> fund_house ->
// buy_in -> init_round -> delegate_session. Returns everything `open` needs.
// `houseFund` lets the under-funded scenario starve the house on purpose.
// ---------------------------------------------------------------------------
async function buildScenario({ funder, baseProvider, program, houseFund, buyInAmount, sliceAmount, expectSliceReject }) {
  const session = Keypair.generate();
  const conn = baseProvider.connection;

  // Fund the fresh session owner from the funder for rent + fees.
  await baseProvider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: session.publicKey,
        lamports: 0.2 * LAMPORTS_PER_SOL,
      })
    )
  );

  // Session-scoped program so session-signed instructions (buy_in / init_round /
  // delegate_session) have the SESSION as both fee-payer AND signer — the exact
  // single-signer topology proven in delegate.ts (avoids the dual-signer
  // confirmation path that surfaced "Unknown action 'undefined'").
  const sessionProvider = new anchor.AnchorProvider(
    conn, new anchor.Wallet(session), { commitment: "confirmed" });
  const programAsSession = new anchor.Program(idl, sessionProvider);
  const mint = await createMint(conn, funder.payer, funder.publicKey, null, 6);
  const [housePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("house2"), mint.toBuffer()], program.programId);
  const till = deriveTill(program.programId, mint, session.publicKey); // per-session till (was the shared house)
  const [feedRegistry] = PublicKey.findProgramAddressSync([Buffer.from("feeds")], program.programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()], program.programId);
  const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
  const [playerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()], program.programId);
  const [roundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), session.publicKey.toBuffer()], program.programId);

  // init_house (funder pays + is authority).
  await program.methods.initHouse(new anchor.BN(0)).accounts({
    authority: funder.publicKey, mint, house: housePda, vaultAuthority, vaultToken,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).signers([funder.payer]).rpc({ skipPreflight: true });

  // Fund the house bankroll: mint `houseFund` USDC to the funder's ATA, fund_house.
  const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, funder.publicKey);
  if (houseFund > 0) {
    await mintTo(conn, funder.payer, mint, funderAta.address, funder.publicKey, houseFund);
    await program.methods.fundHouse(new BN(houseFund)).accounts({
      funder: funder.publicKey, mint, house: housePda, funderToken: funderAta.address,
      vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([funder.payer]).rpc({ skipPreflight: true });
  }

  // Player buys in.
  const ownerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, session.publicKey);
  await mintTo(conn, funder.payer, mint, ownerAta.address, funder.publicKey, buyInAmount);
  await programAsSession.methods.buyIn(new BN(buyInAmount)).accounts({
    owner: session.publicKey, mint, player: playerPda, ownerToken: ownerAta.address,
    vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });

  // init_round.
  await programAsSession.methods.initRound().accounts({
    owner: session.publicKey, round: roundPda, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });

  // slice_from_pot: carve this session's till off the master pot BEFORE delegating it.
  // Under-capitalization is now caught HERE (the pot can't cover the slice) rather than
  // at open — the under-funded scenario passes expectSliceReject to assert this.
  const slice = sliceAmount != null ? sliceAmount : maxPayout(STAKE);
  if (expectSliceReject) {
    let rejected = false, errMsg = "";
    try {
      await programAsSession.methods.sliceFromPot(new BN(slice)).accounts({
        owner: session.publicKey, mint, master: housePda, till, systemProgram: SystemProgram.programId,
      }).rpc();
    } catch (e) {
      rejected = true;
      errMsg = (e && e.toString()) || "";
    }
    return { session, mint, housePda, till, feedRegistry, vaultAuthority, vaultToken, playerPda, roundPda, sliceRejected: rejected, sliceErr: errMsg };
  }
  await programAsSession.methods.sliceFromPot(new BN(slice)).accounts({
    owner: session.publicKey, mint, master: housePda, till, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });

  // Co-delegate all three (player + TILL + round) to the ER.
  await programAsSession.methods.delegateSession().accounts({
    payer: session.publicKey, mint, player: playerPda, house: till, round: roundPda,
  }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
    .rpc({ skipPreflight: true });

  // Poll until all three flip to the delegation program.
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
  assert.ok(flipped.player && flipped.house && flipped.round,
    `not all delegated: ${JSON.stringify(flipped)}`);

  return { session, mint, housePda, till, feedRegistry, vaultAuthority, vaultToken, playerPda, roundPda };
}

describe("raider open (entry snapshot + house max-payout pre-lock, on ER)", function () {
  this.timeout(1_000_000);

  const funder = anchor.Wallet.local(); // ANCHOR_WALLET pays fees + rent + is house authority
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }), funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  before(() => {
    console.log("base    :", BASE_RPC);
    console.log("ER      :", ER_RPC);
    console.log("funder  :", funder.publicKey.toBase58());
    console.log("validator:", VALIDATOR.toBase58());
  });

  it("open snapshots entry, locks 23.75x, and debits the player's stake", async () => {
    const sc = await buildScenario({
      funder, baseProvider, program,
      houseFund: MAX_PAYOUT, // exactly enough for one round
      buyInAmount: 5_000_000, // 5 USDC play balance
    });
    console.log("session :", sc.session.publicKey.toBase58());
    console.log("mint    :", sc.mint.toBase58());

    // ER provider whose wallet is the session owner (it signs as player_authority).
    const erProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(sc.session), { commitment: "confirmed" });
    const programER = new anchor.Program(idl, erProvider);

    const playerBefore = (await programER.account.playerBalance.fetch(sc.playerPda)).balance;

    // open(asset=BTC, dir=long, lev=100, stake=1e6) on the ER — settles against the TILL.
    await programER.methods.open(ASSET_BTC, 1, 100, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts({
      player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, registry: sc.feedRegistry, playerAuthority: sc.session.publicKey,
    }).signers([sc.session]).rpc({ skipPreflight: true });

    const round = await programER.account.round.fetch(sc.roundPda);
    const house = await programER.account.houseBalance.fetch(sc.till);
    const playerAfter = (await programER.account.playerBalance.fetch(sc.playerPda)).balance;

    const usd = round.entryRaw.toNumber() * Math.pow(10, -Math.abs(round.entryExpo));
    console.log(`open OK: status=${round.status} dir=${round.dir} lev=${round.lev} ` +
      `entry_raw=${round.entryRaw.toString()} (~$${usd.toFixed(2)}) entry_ts=${round.entryTs.toString()}`);
    console.log(`house.locked=${house.locked.toString()} player ${playerBefore.toString()} -> ${playerAfter.toString()}`);

    assert.equal(round.status, 1, "round must be open");
    assert.equal(round.dir, 1);
    assert.equal(round.lev, 100);
    assert.equal(round.stake.toString(), STAKE.toString());
    assert.ok(round.entryRaw.toNumber() > 0, "entry_raw must be > 0");
    assert.ok(usd > 1000 && usd < 10_000_000, `implausible BTC entry $${usd}`);
    const entryTs = round.entryTs.toNumber();
    assert.ok(entryTs > 1_700_000_000 && entryTs < 2_000_000_000, `entry_ts ${entryTs} not a sane recent unix`);
    assert.equal(round.maxPayout.toString(), MAX_PAYOUT.toString(), "max_payout must be 23.75x stake");
    assert.equal(house.locked.toString(), MAX_PAYOUT.toString(), "house must pre-lock 23.75x");
    assert.equal((playerBefore.toNumber() - playerAfter.toNumber()), STAKE, "player debited exactly stake");

    // settlement record still zero while open.
    assert.equal(round.exitRaw.toNumber(), 0, "exit_raw zero while open");
    assert.equal(round.payout.toNumber(), 0, "payout zero while open");
  });

  it("a round is REJECTED when the pot cannot cover its slice (HouseUndercapitalized)", async () => {
    // Under the till model the house-solvency gate moves EARLIER: slice_from_pot
    // (pre-delegate, L1) rejects when the master pot can't cover this round's
    // max_payout slice — so the round can never even delegate/open under-capitalized.
    // Fund the pot with 1 USDC less than one round's worst-case slice.
    const sc = await buildScenario({
      funder, baseProvider, program,
      houseFund: MAX_PAYOUT - 1_000_000, // 22.75 USDC < 23.75 slice needed
      buyInAmount: 5_000_000,
      expectSliceReject: true,
    });
    console.log("under-funded session:", sc.session.publicKey.toBase58());

    assert.ok(sc.sliceRejected, "slice_from_pot MUST reject when the pot is under-funded");
    assert.ok(/HouseUndercapitalized/i.test(sc.sliceErr),
      "rejection must be HouseUndercapitalized, got:\n" + sc.sliceErr.split("\n").slice(0, 6).join("\n  "));
    console.log("under-funded pot REJECTED the slice with HouseUndercapitalized as required");

    // And the round never opened — it was never delegated (still program-owned + idle).
    const round = await program.account.round.fetch(sc.roundPda);
    assert.equal(round.status, 0, "round must stay idle after a rejected slice");
  });
});
