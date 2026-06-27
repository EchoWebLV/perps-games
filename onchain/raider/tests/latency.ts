// Task 11 — ER latency re-measurement.
//
// Replaces the Phase-0 1448ms worst-case datum with a properly-measured p50/p95
// for the two game-critical ER round-trips (open, close) as the player actually
// experiences them: submit the ER transaction WITHOUT awaiting confirmation, and
// time (submit -> first `processed` account-change) via a websocket
// accountSubscribe on the Round PDA. We also capture the `confirmed` round-trip
// (the rpc() resolve) for comparison.
//
// Endpoint/validator pairing: the Magic Router SDK (`getClosestValidator`) is not
// vendored here; per the spike's RESULT.md both `devnet.magicblock.app` and
// `devnet-as.magicblock.app` report the SAME validator (MAS1Dt9...). We measure
// against the configured ER_RPC (default us `devnet.magicblock.app`) and print
// the validator identity + the machine region note in the output so the geography
// is recorded honestly.
//
// Each iteration uses a FRESH mint + house + player + round (open/close are
// one-shot per round, and an already-delegated shared house cannot be
// re-delegated), so we measure across N fresh rounds, 2 ER samples each:
// open (cold-ish: first tx on the freshly delegated set) + close (warm).
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
const N = parseInt(process.env.LAT_N || "10", 10); // rounds (2 ER samples each)

const STAKE = 1_000_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
};

describe("raider — ER latency re-measurement (processed + confirmed p50/p95)", function () {
  this.timeout(2_000_000);

  const funder = anchor.Wallet.local();
  const baseConn = new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" });
  const baseProvider = new anchor.AnchorProvider(baseConn, funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  // ER connection used for accountSubscribe (processed) timing.
  const erConn = new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "processed" });

  before(async () => {
    console.log("base    :", BASE_RPC);
    console.log("ER      :", ER_RPC, "| ws", ER_WS);
    console.log("validator (getIdentity expected):", VALIDATOR.toBase58());
    console.log("REGION NOTE: measured from this machine's network region (record honestly in RESULT.md).");
    console.log(`N = ${N} fresh rounds (open + close = ${2 * N} ER round-trip samples)`);
  });

  it(`measures open/close ER round-trip latency over ${N} rounds`, async () => {
    const conn = baseConn;

    // Confirm validator identity once.
    try {
      const id = await erConn._rpcRequest("getIdentity", []);
      console.log("ER getIdentity:", id && id.result && id.result.identity);
    } catch (e) { console.log("getIdentity probe failed (non-fatal):", e.message); }

    const openProcessed = [], openConfirmed = [], closeProcessed = [], closeConfirmed = [];

    for (let it = 0; it < N; it++) {
     // Whole-iteration guard: the ER router occasionally rejects a delegate with
     // a transient "Unknown action 'undefined'". A hiccup must SKIP that iteration,
     // not abort the whole measurement.
     //
     // NB: each iteration uses a FRESH mint + house + player + round so all three
     // delegated PDAs are brand-new. (A shared house cannot be re-delegated each
     // iteration — the second delegate of an already-delegated house is exactly what
     // triggers "Unknown action 'undefined'".)
     try {
      const mint = await createMint(conn, funder.payer, funder.publicKey, null, 6);
      const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
      const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
      const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
      await program.methods.initHouse().accounts({
        authority: funder.publicKey, mint, house: housePda, vaultAuthority, vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc({ skipPreflight: true });
      const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, funder.publicKey);
      await mintTo(conn, funder.payer, mint, funderAta.address, funder.publicKey, 30_000_000);
      await program.methods.fundHouse(new BN(30_000_000)).accounts({
        funder: funder.publicKey, mint, house: housePda, funderToken: funderAta.address,
        vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc({ skipPreflight: true });

      const session = Keypair.generate();
      await baseProvider.sendAndConfirm(new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: session.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })));
      const sessionProvider = new anchor.AnchorProvider(conn, new anchor.Wallet(session), { commitment: "confirmed" });
      const programAsSession = new anchor.Program(idl, sessionProvider);

      const [playerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()], program.programId);
      const [roundPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("round"), session.publicKey.toBuffer()], program.programId);

      const ownerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, session.publicKey);
      await mintTo(conn, funder.payer, mint, ownerAta.address, funder.publicKey, 5_000_000);
      await programAsSession.methods.buyIn(new BN(5_000_000)).accounts({
        owner: session.publicKey, mint, player: playerPda, ownerToken: ownerAta.address,
        vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc({ skipPreflight: true });
      await programAsSession.methods.initRound().accounts({
        owner: session.publicKey, round: roundPda, systemProgram: SystemProgram.programId,
      }).rpc({ skipPreflight: true });
      // delegate with one retry on the transient router error
      let delegated = false;
      for (let attempt = 0; attempt < 2 && !delegated; attempt++) {
        try {
          await programAsSession.methods.delegateSession().accounts({
            payer: session.publicKey, mint, player: playerPda, house: housePda, round: roundPda,
          }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]).rpc({ skipPreflight: true });
          delegated = true;
        } catch (e) {
          if (attempt === 0) { await sleep(2000); } else { throw e; }
        }
      }

      // wait for delegation
      let ok = false;
      for (let i = 0; i < 25; i++) {
        const info = await conn.getAccountInfo(roundPda);
        if (info && info.owner.toBase58() === DELEGATION_PROGRAM.toBase58()) { ok = true; break; }
        await sleep(1000);
      }
      if (!ok) { console.log(`  iter ${it}: delegation timed out, skipping`); continue; }

      const erProvider = new anchor.AnchorProvider(
        new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "processed" }),
        new anchor.Wallet(session), { commitment: "processed" });
      const programER = new anchor.Program(idl, erProvider);

      // ----- time one ER instruction: submit -> first `processed` account-change -----
      // accountSubscribe on the Round PDA fires on the first processed mutation.
      const timeOne = async (buildAndSend, procArr, confArr) => {
        let resolveProc;
        const procP = new Promise((res) => (resolveProc = res));
        const subId = erConn.onAccountChange(roundPda, () => resolveProc(Date.now()), "processed");
        // tiny delay so the subscription is live before we submit
        await sleep(150);
        const t0 = Date.now();
        const confP = buildAndSend(); // returns the rpc() promise (resolves at `confirmed`)
        const procAt = await procP;
        procArr.push(procAt - t0);
        try { await confP; confArr.push(Date.now() - t0); } catch (_) {}
        await erConn.removeAccountChangeListener(subId);
      };

      // open
      await timeOne(
        () => programER.methods.open(1, 100, new BN(STAKE)).accounts({
          player: playerPda, house: housePda, round: roundPda, mint,
          priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
        }).signers([session]).rpc({ skipPreflight: true, commitment: "confirmed" }),
        openProcessed, openConfirmed);

      await sleep(400); // let the feed advance so close has a distinct exit mark

      // close
      await timeOne(
        () => programER.methods.close().accounts({
          player: playerPda, house: housePda, round: roundPda, mint,
          priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
        }).signers([session]).rpc({ skipPreflight: true, commitment: "confirmed" }),
        closeProcessed, closeConfirmed);

      // NB: we deliberately do NOT undelegate per-iteration — the round PDAs are
      // left delegated (cheap; each iteration uses a fresh session/round, so they
      // never collide), keeping this probe focused on the open/close round-trips.

      process.stdout.write(`  iter ${it + 1}/${N}: open ${openProcessed[openProcessed.length - 1]}ms / close ${closeProcessed[closeProcessed.length - 1]}ms (processed)\n`);
     } catch (e) {
       console.log(`  iter ${it + 1}/${N} SKIPPED (transient): ${(e && e.message || e).toString().split("\n")[0]}`);
     }
    }

    const allProc = [...openProcessed, ...closeProcessed];
    const allConf = [...openConfirmed, ...closeConfirmed];
    const report = (name, arr) =>
      console.log(`  ${name.padEnd(22)} n=${arr.length} p50=${pct(arr, 50)}ms p95=${pct(arr, 95)}ms min=${Math.min(...arr)}ms max=${Math.max(...arr)}ms`);

    console.log("\n=== ER LATENCY (submit -> first processed account-change) ===");
    report("open  (processed)", openProcessed);
    report("close (processed)", closeProcessed);
    report("ALL   (processed)", allProc);
    console.log("=== ER LATENCY (submit -> rpc() confirmed resolve) ===");
    report("open  (confirmed)", openConfirmed);
    report("close (confirmed)", closeConfirmed);
    report("ALL   (confirmed)", allConf);
    console.log(`\nSUMMARY: processed p50=${pct(allProc, 50)}ms p95=${pct(allProc, 95)}ms | confirmed p50=${pct(allConf, 50)}ms p95=${pct(allConf, 95)}ms`);

    assert.ok(allProc.length >= Math.floor(N * 0.6) * 2 || allProc.length >= 4,
      `too few latency samples (${allProc.length}) — ER unreachable?`);
  });
});
