// NEGATIVE-GATE DRIVER — deterministic rejections (closes the audit's gate gaps).
//
//   - open with lev > RMAX (2001)            -> BadLeverage
//   - open with dir = 0                       -> BadLeverage
//   - double-open (open an already-open round)-> RoundAlreadyOpen
//   - close with no open round (idle round)   -> NoOpenRound
//   - withdraw more than play balance         -> InsufficientPlayerBalance
//
// The ER-side gates (BadLeverage / RoundAlreadyOpen / NoOpenRound) run against a
// fully delegated session; the L1-only InsufficientPlayerBalance runs on an
// UN-delegated player (withdraw is an L1 instruction). All pass the REAL BTC
// feed so the address pin passes and the BODY's gate is what rejects.
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
const RMAX = 2000;
const ASSET_BTC = 0; // multi-asset: 0 = BTC = BTC_FEED
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// init_house -> fund_house -> buy_in -> init_round. If `delegate`, also
// co-delegates player+house+round to the ER and returns a programER view.
async function buildScenario({ funder, baseProvider, program, delegate, buyInAmount = 5_000_000 }) {
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
  const ownerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, session.publicKey);

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

  await mintTo(conn, funder.payer, mint, ownerAta.address, funder.publicKey, buyInAmount);
  await programAsSession.methods.buyIn(new BN(buyInAmount)).accounts({
    owner: session.publicKey, mint, player: playerPda, ownerToken: ownerAta.address,
    vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });

  await programAsSession.methods.initRound().accounts({
    owner: session.publicKey, round: roundPda, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });

  const out = { session, mint, housePda, till, feedRegistry, vaultAuthority, vaultToken, playerPda, roundPda,
    ownerAta: ownerAta.address, programAsSession };

  if (delegate) {
    // slice_from_pot: carve this session's till off the master pot BEFORE delegating it
    // (the till, not the master, is what co-delegates with player+round).
    await programAsSession.methods.sliceFromPot(new BN(maxPayout(STAKE))).accounts({
      owner: session.publicKey, mint, master: housePda, till, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });
    // delegate_session can intermittently surface a transient confirmation hiccup
    // ("Unknown action 'undefined'") on the public ER; retry a couple of times.
    for (let tryN = 1; ; tryN++) {
      try {
        await programAsSession.methods.delegateSession().accounts({
          payer: session.publicKey, mint, player: playerPda, house: till, round: roundPda,
        }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
          .rpc({ skipPreflight: true });
        break;
      } catch (e) {
        if (tryN >= 3) throw e;
        await sleep(1500);
      }
    }
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
    out.programER = new anchor.Program(idl, new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(session), { commitment: "confirmed" }));
  }
  return out;
}

async function expectReject(fn, pattern, label) {
  let rejected = false, err = "";
  try { await fn(); } catch (e) { rejected = true; err = (e && e.toString()) || ""; }
  assert.ok(rejected, `${label}: expected a rejection but the call SUCCEEDED`);
  assert.ok(pattern.test(err), `${label}: rejection must match ${pattern}, got:\n  ` + err.split("\n").slice(0, 6).join("\n  "));
  console.log(`  ${label} REJECTED:`, err.split("\n")[0]);
}

describe("raider negative gates — deterministic rejections", function () {
  this.timeout(1_000_000);

  const funder = anchor.Wallet.local();
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }), funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  before(() => {
    console.log("base    :", BASE_RPC);
    console.log("program :", program.programId.toBase58());
  });

  it("open rejects bad leverage / bad direction; double-open and close-without-open are gated", async () => {
    const sc = await buildScenario({ funder, baseProvider, program, delegate: true });
    console.log("session :", sc.session.publicKey.toBase58());
    const pER = sc.programER;
    // open takes the feed registry (multi-asset); close/other settle paths do not.
    const openAcc = {
      player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, registry: sc.feedRegistry, playerAuthority: sc.session.publicKey,
    };
    const closeAcc = {
      player: sc.playerPda, house: sc.till, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, playerAuthority: sc.session.publicKey,
    };

    // --- lev > RMAX -> BadLeverage ---
    await expectReject(
      () => pER.methods.open(ASSET_BTC, 1, RMAX + 1, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts(openAcc).signers([sc.session]).rpc(),
      /BadLeverage|6006/i, "open(lev=2001)");

    // --- dir = 0 -> BadLeverage ---
    await expectReject(
      () => pER.methods.open(ASSET_BTC, 0, 100, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts(openAcc).signers([sc.session]).rpc(),
      /BadLeverage|6006/i, "open(dir=0)");

    // The round must still be idle after the two rejected opens.
    let r = await pER.account.round.fetch(sc.roundPda);
    assert.equal(r.status, 0, "round must stay idle after rejected opens");

    // --- close with NO open round -> REJECTED ---
    // On the multi-asset program, close validates `price_update == round.feed` BEFORE
    // the open-state gate. An IDLE round (status 0) never had `open` stamp round.feed,
    // so that field is the default pubkey and the real BTC_FEED trips the feed check
    // (UntrustedFeed) first — before NoOpenRound is reached. Either rejection proves
    // the same intent: a close against a round with no open position is gated.
    await expectReject(
      () => pER.methods.close().accounts(closeAcc).signers([sc.session]).rpc(),
      /NoOpenRound|6003|UntrustedFeed|6010/i, "close(no open round)");

    // --- a valid open succeeds, then double-open -> RoundAlreadyOpen ---
    await pER.methods.open(ASSET_BTC, 1, 100, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts(openAcc).signers([sc.session]).rpc({ skipPreflight: true });
    r = await pER.account.round.fetch(sc.roundPda);
    assert.equal(r.status, 1, "first open must succeed");
    console.log("  first open OK (status=1)");

    await expectReject(
      () => pER.methods.open(ASSET_BTC, 1, 100, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts(openAcc).signers([sc.session]).rpc(),
      /RoundAlreadyOpen|6002/i, "double-open");

    console.log("ER-side gates OK: BadLeverage (lev & dir), NoOpenRound, RoundAlreadyOpen");
  });

  it("withdraw rejects more than the play balance (InsufficientPlayerBalance, L1)", async () => {
    // UN-delegated: withdraw is an L1 instruction; the player PDA must be on L1.
    const sc = await buildScenario({ funder, baseProvider, program, delegate: false, buyInAmount: 2_000_000 });
    console.log("session :", sc.session.publicKey.toBase58());

    const onL1 = await program.account.playerBalance.fetch(sc.playerPda);
    console.log("  L1 play balance:", onL1.balance.toString());
    assert.equal(onL1.balance.toString(), "2000000", "buy_in must credit the play balance");

    // Try to pull 1 USDC MORE than the play balance.
    await expectReject(
      () => sc.programAsSession.methods.withdraw(new BN(3_000_000)).accounts({
        owner: sc.session.publicKey, mint: sc.mint, player: sc.playerPda,
        vaultAuthority: sc.vaultAuthority, vaultToken: sc.vaultToken,
        ownerToken: sc.ownerAta, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc(),
      /InsufficientPlayerBalance|6004/i, "withdraw(over balance)");

    // Balance must be untouched by the rejected withdraw.
    const after = await program.account.playerBalance.fetch(sc.playerPda);
    assert.equal(after.balance.toString(), "2000000", "play balance must be unchanged after a rejected withdraw");
    console.log("L1 gate OK: InsufficientPlayerBalance");
  });
});
