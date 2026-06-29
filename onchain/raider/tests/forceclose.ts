// Task 9 driver: prove `force_close` — the permissionless, time-bounded liveness
// backstop that lets ANYONE unwind a stalled/abandoned round.
//
// Sequence (shared builder, same as open/close): init_house -> fund_house ->
//   buy_in -> init_round -> delegate_session(player+house+round) -> open (ER).
// Then, with a SECOND keypair (a stranger, NOT the round owner):
//   1. force_close BEFORE the deadline -> REJECTED with NotYetExpired.
//   2. wait past round.deadline_ts, force_close AGAIN -> SUCCEEDS:
//        round.status == 2 (settled), house.locked released to 0,
//        and value is conserved across player + house.
//
// This requires the program to be built with the `test-short-deadline` cargo
// feature so MAX_ROUND_SECS is 8s (state.rs) instead of 300s — otherwise the
// post-deadline path would need a 5-minute wait. The DEPLOYED program for this
// test run MUST carry that feature.
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

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const BTC_FEED = new PublicKey(process.env.BTC_FEED || "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
const VALIDATOR = new PublicKey(process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const STAKE = 1_000_000; // 1 USDC
const MAX_PAYOUT = 23_750_000; // max_payout(1e6)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
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

  await programAsSession.methods.delegateSession().accounts({
    payer: session.publicKey, mint, player: playerPda, house: housePda, round: roundPda,
  }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
    .rpc({ skipPreflight: true });

  const targets = { player: playerPda, house: housePda, round: roundPda };
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

  return { session, mint, housePda, vaultAuthority, vaultToken, playerPda, roundPda };
}

describe("raider force_close (permissionless, time-bounded liveness backstop)", function () {
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
    console.log("NOTE: program MUST be built with `test-short-deadline` (MAX_ROUND_SECS=8s).");
  });

  it("a STRANGER cannot force_close before the deadline, but ANYONE can after it", async () => {
    const sc = await buildAndDelegate({
      funder, baseProvider, program,
      houseFund: 30_000_000, // 30 USDC
      buyInAmount: 5_000_000, // 5 USDC
    });
    console.log("owner   :", sc.session.publicKey.toBase58());
    console.log("mint    :", sc.mint.toBase58());

    // A second keypair = a STRANGER (not the round owner). It funds an ER provider
    // and signs force_close as `caller`. Fund it on L1 for any base-layer fees.
    const stranger = Keypair.generate();
    await baseProvider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey, toPubkey: stranger.publicKey,
          lamports: 0.1 * LAMPORTS_PER_SOL,
        })));
    console.log("stranger:", stranger.publicKey.toBase58());

    // ER providers: the owner opens the round; the stranger attempts force_close.
    const ownerEr = new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(sc.session), { commitment: "confirmed" });
    const programOwnerER = new anchor.Program(idl, ownerEr);

    const strangerEr = new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(stranger), { commitment: "confirmed" });
    const programStrangerER = new anchor.Program(idl, strangerEr);

    const sumBalances = async () => {
      const p = await programOwnerER.account.playerBalance.fetch(sc.playerPda);
      const h = await programOwnerER.account.houseBalance.fetch(sc.housePda);
      return BigInt(p.balance.toString()) + BigInt(h.balance.toString()) + BigInt(h.locked.toString());
    };

    const totalBefore = await sumBalances();
    console.log("total BEFORE open:", totalBefore.toString());

    // --- open(long, 100x, 1 USDC) by the OWNER ---
    await programOwnerER.methods.open(1, 100, new BN(STAKE)).accounts({
      player: sc.playerPda, house: sc.housePda, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, playerAuthority: sc.session.publicKey,
    }).signers([sc.session]).rpc({ skipPreflight: true });

    const opened = await programOwnerER.account.round.fetch(sc.roundPda);
    console.log(`opened: status=${opened.status} entry_raw=${opened.entryRaw.toString()} ` +
      `deadline_ts=${opened.deadlineTs.toString()} (now ~${Math.floor(Date.now() / 1000)})`);
    assert.equal(opened.status, 1, "round must be open");
    const house0 = await programOwnerER.account.houseBalance.fetch(sc.housePda);
    assert.equal(house0.locked.toString(), MAX_PAYOUT.toString(), "house must pre-lock 23.75x");

    // --- 1) STRANGER force_close BEFORE deadline -> REJECTED (NotYetExpired) ---
    let rejected = false, errMsg = "";
    try {
      await programStrangerER.methods.forceClose().accounts({
        player: sc.playerPda, house: sc.housePda, round: sc.roundPda, mint: sc.mint,
        priceUpdate: BTC_FEED, caller: stranger.publicKey,
      }).signers([stranger]).rpc(); // preflight ON so the code surfaces
    } catch (e) {
      rejected = true;
      errMsg = (e && e.toString()) || "";
    }
    assert.ok(rejected, "force_close MUST reject before the deadline");
    assert.ok(/NotYetExpired/i.test(errMsg),
      "pre-deadline rejection must be NotYetExpired, got:\n  " + errMsg.split("\n").slice(0, 6).join("\n  "));
    console.log("PRE-DEADLINE force_close REJECTED with NotYetExpired (as required)");

    // round still open, lock still held.
    const stillOpen = await programOwnerER.account.round.fetch(sc.roundPda);
    assert.equal(stillOpen.status, 1, "round must stay open after a rejected force_close");

    // --- wait past the deadline (MAX_ROUND_SECS=8s under test-short-deadline) ---
    const nowSec = Math.floor(Date.now() / 1000);
    const waitSec = Math.max(0, opened.deadlineTs.toNumber() - nowSec) + 3; // +3s slack
    console.log(`waiting ~${waitSec}s for the round deadline to pass...`);
    await sleep(waitSec * 1000);

    // --- 2) STRANGER force_close AFTER deadline -> SUCCEEDS ---
    await programStrangerER.methods.forceClose().accounts({
      player: sc.playerPda, house: sc.housePda, round: sc.roundPda, mint: sc.mint,
      priceUpdate: BTC_FEED, caller: stranger.publicKey,
    }).signers([stranger]).rpc({ skipPreflight: true });

    const settled = await programOwnerER.account.round.fetch(sc.roundPda);
    const house1 = await programOwnerER.account.houseBalance.fetch(sc.housePda);
    // Outcome 3 (time) is the Phase-2 relabel: force_close past the deadline now
    // settles a Cashout-equivalent as `time` (see settle_round's now>=deadline_ts
    // relabel). Include it so the log reads "time" not "undefined".
    const outName = ["cashout", "cap", "liq", "time"][settled.outcome];
    console.log(`POST-DEADLINE force_close OK: status=${settled.status} outcome=${settled.outcome}(${outName}) ` +
      `payout=${settled.payout.toString()} exit_raw=${settled.exitRaw.toString()} ` +
      `house.locked=${house1.locked.toString()}`);

    assert.equal(settled.status, 2, "round must be settled after a post-deadline force_close");
    assert.ok(settled.exitRaw.toNumber() > 0, "exit_raw must be recorded");
    assert.equal(house1.locked.toString(), "0", "house lock MUST be released after force_close");

    // value conserved end-to-end (a stranger settling cannot create/destroy value).
    const totalAfter = await sumBalances();
    console.log("total AFTER force_close:", totalAfter.toString());
    assert.equal(totalAfter.toString(), totalBefore.toString(),
      "value conserved across player+house (before open == after force_close)");
  });
});
