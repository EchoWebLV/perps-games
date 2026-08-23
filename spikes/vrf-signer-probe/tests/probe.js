// vrf-signer-probe driver. Plain node (no mocha) so every log line is visible.
//
//   node tests/probe.js setup       -- L1: init_probe + delegate_probe
//   node tests/probe.js direct      -- ER: fire request_ro / request_w as CLIENT txs
//                                      (all ix metas is_signer:false). Isolates the
//                                      ephemeral-vrf checks from the scheduler.
//   node tests/probe.js schedule ro|w [iters] -- ER: arm ScheduleTask, then POLL ONLY.
//   node tests/probe.js state       -- read the probe account on ER + L1
//
// The `schedule` stage must NEVER call request_* itself; the whole measurement is
// that the validator does it.
const path = require("path");
const NM = "/Users/yordanlasonov/Documents/GitHub/perps-games/onchain/raider/node_modules";
const anchor = require(path.join(NM, "@coral-xyz/anchor"));
const { PublicKey, Keypair, Connection, Transaction, ComputeBudgetProgram } = require(path.join(NM, "@solana/web3.js"));
const fs = require("fs");

const idl = require("../target/idl/vrf_signer_probe.json");
const PID = new PublicKey(idl.address);

const BASE_RPC = "https://api.devnet.solana.com";
const BASE_WS = "wss://api.devnet.solana.com";
const ER_RPC = "https://devnet.magicblock.app";
const ER_WS = "wss://devnet.magicblock.app";
const VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const VRF = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const MAGIC = new PublicKey("Magic11111111111111111111111111111111111111");
const SLOTHASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json")))
);
const wallet = new anchor.Wallet(kp);
const baseConn = new Connection(BASE_RPC, { commitment: "confirmed", wsEndpoint: BASE_WS });
const erConn = new Connection(ER_RPC, { commitment: "confirmed", wsEndpoint: ER_WS });
const mk = (conn) => new anchor.Program(idl, new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" }));
const p1 = mk(baseConn);
const pER = mk(erConn);

const PROBE = PublicKey.findProgramAddressSync([Buffer.from("probe")], PID)[0];
const IDENTITY = PublicKey.findProgramAddressSync([Buffer.from("identity")], PID)[0];
const SCOPED = PublicKey.findProgramAddressSync([Buffer.from("identity"), PID.toBuffer()], VRF)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw send + HTTP-poll confirm, then fetch logs. Never throws on tx failure —
// a failed tx is data here, not an accident.
async function send(conn, ix, { cu = 400_000, label = "" } = {}) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(kp);
  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  } catch (e) {
    console.log(`  ${label}: SEND REJECTED: ${e.message}`);
    if (e.logs) console.log("   logs:\n    " + e.logs.join("\n    "));
    return { sig: null, err: e.message, logs: e.logs || [] };
  }
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      const txr = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = (txr && txr.meta && txr.meta.logMessages) || [];
      console.log(`  ${label}: ${st.err ? "FAILED " + JSON.stringify(st.err) : "OK"}  sig=${sig}`);
      if (logs.length) console.log("   logs:\n    " + logs.join("\n    "));
      return { sig, err: st.err, logs };
    }
    await sleep(1000);
  }
  console.log(`  ${label}: NOT CONFIRMED in 60s  sig=${sig}`);
  return { sig, err: "timeout", logs: [] };
}

function showProbe(tag, p) {
  if (!p) return console.log(`  ${tag}: <missing>`);
  console.log(
    `  ${tag}: attempts=${p.attempts} ok=${p.ok} failures=${p.failures} lastErr=${p.lastErr} ` +
      `lastVariant=${p.lastVariant} fulfilled=${p.fulfilled} tag=0x${p.tag.toString(16)} slot=${p.slot} ` +
      `rnd=${Buffer.from(p.randomness).toString("hex").slice(0, 24)}...`
  );
}

async function readProbe(conn) {
  try {
    return await mk(conn).account.probe.fetch(PROBE);
  } catch (e) {
    return null;
  }
}

async function setup() {
  console.log("program  ", PID.toBase58());
  console.log("probe PDA", PROBE.toBase58());
  console.log("identity ", IDENTITY.toBase58());
  console.log("scoped id", SCOPED.toBase58());
  const existing = await baseConn.getAccountInfo(PROBE);
  if (!existing) {
    const ix = await p1.methods.initProbe().accounts({ payer: kp.publicKey }).instruction();
    await send(baseConn, ix, { label: "init_probe (L1)" });
  } else {
    console.log(`  probe already exists on L1, owner=${existing.owner.toBase58()}`);
  }
  const after = await baseConn.getAccountInfo(PROBE);
  const DELEG = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
  if (after && after.owner.toBase58() === DELEG) {
    console.log("  probe already delegated");
  } else {
    const ix = await p1.methods
      .delegateProbe()
      .accounts({ payer: kp.publicKey })
      .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
      .instruction();
    await send(baseConn, ix, { label: "delegate_probe (L1)" });
  }
  const er = await erConn.getAccountInfo(PROBE);
  console.log(`  probe in ER: ${er ? `owner=${er.owner.toBase58()} len=${er.data.length}` : "MISSING"}`);
  showProbe("probe(ER) ", await readProbe(erConn));
}

async function direct() {
  const which = process.argv[3] || "both";
  for (const variant of which === "both" ? ["ro", "w"] : [which]) {
    const m = variant === "ro" ? pER.methods.requestRo() : pER.methods.requestW();
    const ix = await m
      .accounts({
        probe: PROBE,
        programIdentity: IDENTITY,
        oracleQueue: QUEUE,
        vrfProgram: VRF,
        slotHashes: SLOTHASHES,
      })
      .instruction();
    console.log(`\n--- request_${variant} as a CLIENT tx on the ER ---`);
    ix.keys.forEach((k, i) =>
      console.log(`   meta ${i} ${k.pubkey.toBase58()} signer=${k.isSigner} writable=${k.isWritable}`)
    );
    const anySigner = ix.keys.some((k) => k.isSigner);
    console.log(`   NO-SIGNER instruction: ${!anySigner}`);
    await send(erConn, ix, { label: `request_${variant}` });
    showProbe(`probe after ${variant}`, await readProbe(erConn));
  }
  console.log("\n--- waiting 20s for any callback ---");
  await sleep(20000);
  showProbe("probe final", await readProbe(erConn));
}

async function schedule() {
  const variant = process.argv[3] || "ro";
  const iters = Number(process.argv[4] || 20);
  const before = await readProbe(erConn);
  showProbe("probe before arming", before);

  const m =
    variant === "ro"
      ? pER.methods.scheduleRo(new anchor.BN(Date.now() % 1e9), new anchor.BN(3000), new anchor.BN(iters))
      : pER.methods.scheduleW(new anchor.BN(Date.now() % 1e9), new anchor.BN(3000), new anchor.BN(iters));
  const ix = await m
    .accounts({
      magicProgram: MAGIC,
      payer: kp.publicKey,
      probe: PROBE,
      programIdentity: IDENTITY,
      oracleQueue: QUEUE,
      vrfProgram: VRF,
      slotHashes: SLOTHASHES,
    })
    .instruction();
  console.log(`\n--- schedule_${variant}: 3000ms x${iters} ---`);
  const r = await send(erConn, ix, { label: `schedule_${variant}` });
  if (r.err) {
    console.log("  ARMING FAILED — nothing further to measure for this variant.");
    return;
  }
  console.log("  ARMED. POLLING ONLY from here — the driver never calls request_*.");
  const WATCH = 90;
  for (let i = 5; i <= WATCH; i += 5) {
    await sleep(5000);
    const p = await readProbe(erConn);
    showProbe(`t=${i}s`, p);
    if (p && p.fulfilled > (before ? before.fulfilled : 0)) {
      console.log("  CALLBACK LANDED.");
      break;
    }
  }
}

async function state() {
  console.log("program  ", PID.toBase58());
  console.log("probe    ", PROBE.toBase58());
  console.log("identity ", IDENTITY.toBase58());
  console.log("scoped id", SCOPED.toBase58());
  for (const [n, c] of [["L1", baseConn], ["ER", erConn]]) {
    const ai = await c.getAccountInfo(PROBE);
    console.log(`  probe on ${n}: ${ai ? `owner=${ai.owner.toBase58()} len=${ai.data.length}` : "MISSING"}`);
    showProbe(`probe(${n})`, await readProbe(c));
    const id = await c.getAccountInfo(IDENTITY);
    console.log(`  identity on ${n}: ${id ? `owner=${id.owner.toBase58()} len=${id.data.length} lamports=${id.lamports}` : "MISSING"}`);
  }
}

const stage = process.argv[2] || "state";
({ setup, direct, schedule, state }[stage] || state)().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
