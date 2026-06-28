// Task 8 crank-probe driver: GREEN/RED gate for native ScheduleTask on the
// public devnet MagicBlock ER validator.
//
// Flow: initialize (base) -> delegate Counter to the ER (validator as the single
// remaining account) -> schedule_increment({taskId:1, intervalMs:200, iters:5})
// ON THE ER -> sleep(2000) with NO further tx -> read counter.value on the ER.
// GREEN iff value >= 5 (the validator auto-invoked `increment` with zero client tx).
//
// We must NOT manually call `increment` from the client — the whole point is that
// the validator drives it. The counter must advance during a pure sleep.
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const BN = anchor.BN;
const assert = require("assert");
const idl = require("../target/idl/crank_probe.json");

const BASE_RPC =
  process.env.BASE_RPC ||
  "https://devnet.helius-rpc.com/?api-key=e0eb777f-deda-4f69-bfcd-726807ad1a42";
// rpc-websockets v9 WS bug ("Unknown action 'undefined'") fires on heavy base-layer
// tx (e.g. delegate); pin the base WS to the public devnet endpoint.
const BASE_WS = process.env.BASE_WS || "wss://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const VALIDATOR = new PublicKey(
  process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"
);
const DELEGATION_PROGRAM = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");

// Probe parameters
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 200);
const ITERATIONS = Number(process.env.ITERATIONS || 5);
const SLEEP_MS = Number(process.env.SLEEP_MS || 2000);
const GREEN_THRESHOLD = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("crank-probe spike", function () {
  this.timeout(1_000_000);

  const wallet = anchor.Wallet.local(); // ANCHOR_WALLET
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, {
      wsEndpoint: BASE_WS,
      commitment: "confirmed",
    }),
    wallet,
    { commitment: "confirmed" }
  );
  const erProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(ER_RPC, {
      wsEndpoint: ER_WS,
      commitment: "confirmed",
    }),
    wallet,
    { commitment: "confirmed" }
  );

  const program = new anchor.Program(idl, baseProvider);
  const programER = new anchor.Program(idl, erProvider);
  const [counterPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter")],
    program.programId
  );

  before(() => {
    console.log("base     :", BASE_RPC);
    console.log("ER       :", ER_RPC, "(validator", VALIDATOR.toBase58() + ")");
    console.log("wallet   :", wallet.publicKey.toBase58());
    console.log("counter  :", counterPDA.toBase58());
    console.log("program  :", program.programId.toBase58());
    console.log(
      `probe    : interval ${INTERVAL_MS}ms x ${ITERATIONS} iters, sleep ${SLEEP_MS}ms, GREEN iff value>=${GREEN_THRESHOLD}`
    );
  });

  it("1) initialize Counter on base layer (skip if present)", async () => {
    const existing = await baseProvider.connection.getAccountInfo(counterPDA);
    if (existing) {
      console.log("counter already exists, owner", existing.owner.toBase58());
      return;
    }
    await program.methods
      .initialize()
      .accounts({
        user: wallet.publicKey,
        counter: counterPDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ skipPreflight: true });
    const acct = await baseProvider.connection.getAccountInfo(counterPDA);
    assert.equal(acct.owner.toBase58(), program.programId.toBase58());
    console.log("initialized; owner", acct.owner.toBase58());
  });

  it("2) delegate Counter to the ER (owner flips to delegation program)", async () => {
    const owner = (
      await baseProvider.connection.getAccountInfo(counterPDA)
    ).owner.toBase58();
    if (owner === DELEGATION_PROGRAM.toBase58()) {
      console.log("already delegated");
      return;
    }
    await program.methods
      .delegate()
      .accounts({ payer: wallet.publicKey, counter: counterPDA })
      .remainingAccounts([
        { pubkey: VALIDATOR, isSigner: false, isWritable: false },
      ])
      .rpc({ skipPreflight: true });
    for (let i = 0; i < 20; i++) {
      const o = (
        await baseProvider.connection.getAccountInfo(counterPDA)
      ).owner.toBase58();
      if (o === DELEGATION_PROGRAM.toBase58()) {
        console.log("delegated after", (i + 1) * 1000, "ms");
        return;
      }
      await sleep(1000);
    }
    assert.fail("owner did not flip to delegation program within 20s");
  });

  it(`3) schedule_increment on the ER (task 1, ${INTERVAL_MS}ms x ${ITERATIONS}) — NO further client tx`, async () => {
    const start = (await programER.account.counter.fetch(counterPDA)).value.toNumber();
    console.log("counter.value before schedule:", start);

    // schedule_increment runs INSIDE the ER (counter is delegated). The validator
    // is supposed to pick up the task and auto-run `increment`.
    let sig;
    try {
      sig = await programER.methods
        .scheduleIncrement({
          taskId: new BN(1),
          executionIntervalMillis: new BN(INTERVAL_MS),
          iterations: new BN(ITERATIONS),
        })
        .accounts({
          magicProgram: MAGIC_PROGRAM,
          payer: wallet.publicKey,
          counter: counterPDA,
        })
        .rpc({ skipPreflight: true });
      console.log("schedule_increment tx (ER):", sig);
    } catch (e) {
      // A RED outcome: the schedule tx errored. Capture and surface the exact error.
      console.error("SCHEDULE TX ERRORED (candidate RED):");
      console.error(String(e && e.message ? e.message : e));
      if (e && e.logs) console.error("logs:\n" + e.logs.join("\n"));
      throw e;
    }
  });

  it(`4) VERDICT: pure sleep ${SLEEP_MS}ms, then read counter.value (GREEN iff >=${GREEN_THRESHOLD})`, async () => {
    const before = (await programER.account.counter.fetch(counterPDA)).value.toNumber();
    console.log(`value right after schedule: ${before}; sleeping ${SLEEP_MS}ms with NO client tx...`);
    await sleep(SLEEP_MS);
    const after = (await programER.account.counter.fetch(counterPDA)).value.toNumber();
    console.log(`value after ${SLEEP_MS}ms sleep: ${after} (advanced ${after - before} during sleep)`);

    // Sample once more to show whether it is still ticking / settled at iterations.
    await sleep(1000);
    const after2 = (await programER.account.counter.fetch(counterPDA)).value.toNumber();
    console.log(`value after +1000ms more: ${after2}`);

    if (after >= GREEN_THRESHOLD) {
      console.log(`GREEN: counter auto-incremented to ${after} (>= ${GREEN_THRESHOLD}) with NO client tx.`);
      console.log(`  scheduled-tx fee payer was: ${wallet.publicKey.toBase58()} (the schedule payer); the validator executes the crank.`);
    } else {
      console.log(`RED: counter stayed at ${after} (< ${GREEN_THRESHOLD}) after a pure sleep — validator did not auto-run the scheduled increment.`);
    }
    assert.ok(
      after >= GREEN_THRESHOLD,
      `RED: counter.value=${after} after ${SLEEP_MS}ms no-tx sleep (need >=${GREEN_THRESHOLD}). Validator did not honor ScheduleTask.`
    );
  });
});
