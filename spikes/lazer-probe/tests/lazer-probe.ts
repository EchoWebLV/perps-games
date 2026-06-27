// Phase 0 spike driver: delegate Probe to the MagicBlock devnet ER, read the
// live Pyth Lazer BTC/USD feed inside the ER, measure latency, then
// commit+undelegate back to L1. See docs/superpowers/plans/2026-06-27-onchain-er-lazer-spike.md
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const assert = require("assert");
const idl = require("../target/idl/lazer_probe.json");

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const BTC_FEED = new PublicKey(process.env.BTC_FEED || "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
const VALIDATOR = new PublicKey(process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const N = Number(process.env.SAMPLES || 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("lazer-probe spike", function () {
  this.timeout(1_000_000);

  const wallet = anchor.Wallet.local(); // ANCHOR_WALLET
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }), wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }), wallet, { commitment: "confirmed" });

  const program = new anchor.Program(idl, baseProvider);
  const programER = new anchor.Program(idl, erProvider);
  const [probePDA] = PublicKey.findProgramAddressSync([Buffer.from("probe")], program.programId);
  const latencies = [];

  before(() => {
    console.log("base  :", BASE_RPC);
    console.log("ER    :", ER_RPC, "(validator", VALIDATOR.toBase58() + ")");
    console.log("wallet:", wallet.publicKey.toBase58());
    console.log("probe :", probePDA.toBase58());
  });

  it("0) BTC feed account is live on the ER endpoint", async () => {
    const info = await erProvider.connection.getAccountInfo(BTC_FEED);
    assert.ok(info && info.data.length > 0, "BTC feed account missing/empty on ER_RPC");
    console.log(`BTC feed size=${info.data.length} owner=${info.owner.toBase58()}`);
  });

  it("1) initialize Probe on base layer (skip if present)", async () => {
    const existing = await baseProvider.connection.getAccountInfo(probePDA);
    if (existing) { console.log("probe already exists, owner", existing.owner.toBase58()); return; }
    await program.methods.initialize()
      .accounts({ user: wallet.publicKey, probe: probePDA, systemProgram: SystemProgram.programId })
      .rpc({ skipPreflight: true });
    const acct = await baseProvider.connection.getAccountInfo(probePDA);
    assert.equal(acct.owner.toBase58(), program.programId.toBase58());
    console.log("initialized; owner", acct.owner.toBase58());
  });

  it("2) delegate Probe to the ER (owner flips to delegation program)", async () => {
    const owner = (await baseProvider.connection.getAccountInfo(probePDA)).owner.toBase58();
    if (owner === DELEGATION_PROGRAM.toBase58()) { console.log("already delegated"); return; }
    await program.methods.delegate()
      .accounts({ payer: wallet.publicKey, probe: probePDA })
      .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
      .rpc({ skipPreflight: true });
    for (let i = 0; i < 15; i++) {
      const o = (await baseProvider.connection.getAccountInfo(probePDA)).owner.toBase58();
      if (o === DELEGATION_PROGRAM.toBase58()) { console.log("delegated after", (i + 1) * 1000, "ms"); return; }
      await sleep(1000);
    }
    assert.fail("owner did not flip to delegation program within 15s");
  });

  it(`3) sample ${N}x on the ER — latency + live price`, async () => {
    const startTicks = (await programER.account.probe.fetch(probePDA)).tickCount.toNumber();
    let prevTs = 0, advanced = 0;
    for (let i = 0; i < N; i++) {
      const start = Date.now();
      try {
        await programER.methods.sample().accounts({ probe: probePDA, priceUpdate: BTC_FEED }).rpc({ skipPreflight: true });
      } catch (e) {
        if (i === 0) { await sleep(3000); await programER.methods.sample().accounts({ probe: probePDA, priceUpdate: BTC_FEED }).rpc({ skipPreflight: true }); }
        else throw e;
      }
      latencies.push(Date.now() - start);
      const p = await programER.account.probe.fetch(probePDA);
      const ts = p.lastTs.toNumber();
      if (ts > prevTs) advanced++;
      prevTs = ts;
    }
    const p = await programER.account.probe.fetch(probePDA);
    // MagicBlock Pyth Lazer feeds store the exponent as a POSITIVE magnitude
    // (USD = price * 10^-expo), unlike the standard Pyth pull-oracle (negative).
    const usd = p.lastPrice.toNumber() * Math.pow(10, -Math.abs(p.lastExpo));
    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)];
    console.log(`MEDIAN ER ROUND-TRIP: ${median}ms (min ${latencies[0]}, max ${latencies[latencies.length - 1]})`);
    console.log(`on-chain BTC: $${usd.toFixed(2)} | raw ${p.lastPrice.toString()} expo ${p.lastExpo} | ts ${p.lastTs.toString()} advanced ${advanced}/${N - 1} | ticks ${p.tickCount.toString()}`);
    try {
      const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
      console.log("off-chain BTC (binance): $" + (await r.json()).price);
    } catch { /* optional */ }

    assert.equal(p.tickCount.toNumber() - startTicks, N, "tick_count did not increase by N this run");
    assert.ok(usd > 1000 && usd < 10_000_000, `implausible BTC price $${usd} — decode/offset wrong`);
    assert.ok(prevTs > 1_700_000_000 && prevTs < 2_000_000_000, `last_ts ${prevTs} not a sane recent unix time — decode wrong`);
    assert.ok(advanced >= 1, "last_ts never advanced — feed frozen, not live");
    if (median >= 150) console.warn(`WARN: median ER latency ${median}ms exceeds 150ms target (record real number)`);
  });

  it("4) commit + undelegate — final price lands back on L1", async () => {
    const erBefore = await programER.account.probe.fetch(probePDA);
    await programER.methods.commitAndUndelegate()
      .accounts({ payer: wallet.publicKey, probe: probePDA })
      .rpc({ skipPreflight: true });
    let owner = "";
    for (let i = 0; i < 30; i++) {
      owner = (await baseProvider.connection.getAccountInfo(probePDA)).owner.toBase58();
      if (owner === program.programId.toBase58()) break;
      await sleep(2000);
    }
    assert.equal(owner, program.programId.toBase58(), "Probe did not undelegate back within 60s");
    const onL1 = await program.account.probe.fetch(probePDA);
    assert.equal(onL1.lastPrice.toString(), erBefore.lastPrice.toString(), "committed price != ER state");
    console.log(`L1 round-trip OK: last_price ${onL1.lastPrice.toString()} persisted; owner back to program`);
  });
});
