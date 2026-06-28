// Secondary probe: confirm auto-ticking happens DURING a pure sleep, and measure
// the min execution_interval_millis that still fires + max iterations honored.
// Counter is already delegated (run crank-probe.ts first). Uses fresh task_ids.
const anchor = require("@coral-xyz/anchor");
const { PublicKey } = require("@solana/web3.js");
const BN = anchor.BN;
const idl = require("../target/idl/crank_probe.json");

const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("crank-probe limits", function () {
  this.timeout(1_000_000);
  const wallet = anchor.Wallet.local();
  const erProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
    wallet,
    { commitment: "confirmed" }
  );
  const programER = new anchor.Program(idl, erProvider);
  const [counterPDA] = PublicKey.findProgramAddressSync([Buffer.from("counter")], programER.programId);

  async function probe(taskId, intervalMs, iterations, observeMs) {
    const before = (await programER.account.counter.fetch(counterPDA)).value.toNumber();
    const t0 = Date.now();
    await programER.methods
      .scheduleIncrement({ taskId: new BN(taskId), executionIntervalMillis: new BN(intervalMs), iterations: new BN(iterations) })
      .accounts({ magicProgram: MAGIC_PROGRAM, payer: wallet.publicKey, counter: counterPDA })
      .rpc({ skipPreflight: true });
    const afterTx = (await programER.account.counter.fetch(counterPDA)).value.toNumber();
    // Sample the counter over the observation window to watch it tick live.
    const samples = [];
    const deadline = Date.now() + observeMs;
    while (Date.now() < deadline) {
      await sleep(Math.max(intervalMs, 150));
      samples.push((await programER.account.counter.fetch(counterPDA)).value.toNumber());
    }
    const final = (await programER.account.counter.fetch(counterPDA)).value.toNumber();
    const ticked = final - before;
    console.log(
      `[task ${taskId}] interval=${intervalMs}ms iters=${iterations}: before=${before} afterScheduleTx=${afterTx} final=${final} ticked=${ticked} (txConfirm=${afterTx - before}) samples=[${samples.join(",")}]`
    );
    return ticked;
  }

  it("A) interval 1000ms x 6 — observe live ticking during a pure sleep", async () => {
    // Long interval so the schedule tx returns before all cranks fire → we SEE it tick during sleep.
    const ticked = await probe(101, 1000, 6, 8000);
    console.log(ticked === 6 ? "  -> honored exactly 6 iterations" : `  -> ticked ${ticked}/6`);
  });

  it("B) interval 100ms x 8 — probe a lower interval", async () => {
    const ticked = await probe(102, 100, 8, 4000);
    console.log(ticked >= 1 ? `  -> 100ms interval FIRES (ticked ${ticked}/8)` : "  -> 100ms interval did NOT fire");
  });

  it("C) interval 50ms x 8 — probe an even lower interval", async () => {
    const ticked = await probe(103, 50, 8, 4000);
    console.log(ticked >= 1 ? `  -> 50ms interval FIRES (ticked ${ticked}/8)` : "  -> 50ms interval did NOT fire");
  });

  it("D) iterations 50 x interval 100ms — probe a higher iteration count", async () => {
    const ticked = await probe(104, 100, 50, 9000);
    console.log(`  -> ticked ${ticked}/50 over the window`);
  });
});
