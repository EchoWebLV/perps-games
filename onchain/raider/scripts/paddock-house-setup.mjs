// PADDOCK HOUSE SETUP — stand up the real wSOL book on devnet, idempotently.
//
// The e2e (tests/paddock-e2e.ts) proves the loop against a throwaway 6-decimal
// mint. The game client plays in wSOL (redline3d/src/chain/config.ts,
// ACTIVE_STAKE_CURRENCY) so the player flow stays "send SOL -> bet". This script
// is the house-side, one-time deploy of that wSOL book:
//
//   1. init_book(validator)   L1  — ledger + program-owned vault ATA
//   2. init_race(entrants,strengths)  L1  — the singleton Race, idle
//   3. delegate_race()        L1  — hand the Race to the ER validator
//   4. schedule_race_crank()  ER  — arm the native scheduler
//
// `init_book` is FIRST-COME with no authority gate (same posture as raider's
// `init_house`), so the house must win the PDA before anyone else squats it.
//
// EVERY step is skipped, not failed, when its account already exists / is already
// delegated, so a re-run is a no-op. Step 4 has no on-chain marker to read — the
// MagicBlock scheduler keeps tasks in validator state, not in an account we can
// fetch — so its idempotency check is BEHAVIOURAL: watch the ER Race for movement
// no client transaction could have caused, and only arm when it is frozen.
//
// Run:
//   cd onchain/raider && ANCHOR_WALLET=$HOME/.config/solana/id.json \
//     ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//     node scripts/paddock-house-setup.mjs
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const { BN } = anchor;

// --- constants (mirrors tests/helpers.ts; program id read from the IDL) --------
const idl = JSON.parse(
  readFileSync(new URL("../target/idl/paddock.json", import.meta.url), "utf8")
);
const PROGRAM_ID = new PublicKey(idl.address);

const BASE_RPC =
  process.env.ANCHOR_PROVIDER_URL || process.env.BASE_RPC || "https://api.devnet.solana.com";
// Pinned WS: some HTTP providers serve a signature stream rpc-websockets v9 cannot
// parse. Every send here is HTTP-poll anyway (sendIxHttp), so this is belt-only.
const BASE_WS = process.env.BASE_WS || "wss://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const BTC_FEED = new PublicKey(
  process.env.BTC_FEED || "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"
);
const VALIDATOR = new PublicKey(
  process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"
);
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
// wSOL. 9 decimals. The client's ACTIVE_STAKE_CURRENCY.
const MINT = new PublicKey(
  process.env.BOOK_MINT || "So11111111111111111111111111111111111111112"
);

const CRANK_INTERVAL_MS = Number(process.env.CRANK_INTERVAL_MS || 1000);
const CRANK_ITERATIONS = Number(process.env.CRANK_ITERATIONS || 1_000_000);
const TASK_ID = Number(process.env.TASK_ID || Date.now() % 1e9);

// --- the grid ----------------------------------------------------------------
// Seeded from the client's real roster so the on-chain grid and the rendered cars
// agree slot-for-slot: DEFAULT_GRID (redline3d/src/render/race-mode.ts) in order,
// with each car's strength taken from STRENGTH (redline3d/src/core/race-grid.ts,
// rarity -> float) scaled by 1000 into the u16 the program stores.
//
// `entrants[i]` is the DEFAULT_GRID index of the car in slot i. The crank permutes
// entrants and strengths TOGETHER on every roll (lib.rs PHASE_SETTLED), so the pair
// stays attached and the client can always read `entrants[i]` to know which car
// occupies slot i.
const STRENGTH = { 1: 1.0, 2: 1.35, 3: 1.8, 4: 2.4, 5: 3.2 };
const ROSTER = [
  { name: "Bedrock", rarity: 5 },
  { name: "DeLorean", rarity: 4 },
  { name: "Cybertruck", rarity: 3 },
  { name: "Vaporwave", rarity: 3 },
  { name: "Prickle", rarity: 2 },
  { name: "Knockout", rarity: 3 },
  { name: "Big Frank", rarity: 1 },
  { name: "Trabant", rarity: 1 },
];
const ENTRANTS = ROSTER.map((_, i) => i);
const STRENGTHS = ROSTER.map((c) => Math.round(STRENGTH[c.rarity] * 1000));

const PHASE_NAME = ["MARKET", "RACING", "SETTLED"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send + confirm by HTTP polling only, no WS — the same helper the paddock e2e
// uses (tests/helpers.ts:37). delegate_race is a heavy CPI near the default CU
// limit, hence the explicit 400k budget.
async function sendIxHttp(conn, methodBuilder, signer) {
  const tx = await methodBuilder.transaction();
  tx.instructions.unshift(
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })
  );
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      if (st.err) throw new Error("tx " + sig + " failed: " + JSON.stringify(st.err));
      return sig;
    }
    await sleep(1000);
  }
  throw new Error("tx " + sig + " not confirmed within 60s");
}

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

// --- main --------------------------------------------------------------------
const walletPath = process.env.ANCHOR_WALLET || `${homedir()}/.config/solana/id.json`;
const house = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(walletPath, "utf8")))
);
const baseConn = new Connection(BASE_RPC, { commitment: "confirmed", wsEndpoint: BASE_WS });
const erConn = new Connection(ER_RPC, { commitment: "confirmed", wsEndpoint: ER_WS });
const mk = (conn) =>
  new anchor.Program(
    idl,
    new anchor.AnchorProvider(conn, new anchor.Wallet(house), { commitment: "confirmed" })
  );
const l1 = mk(baseConn);
const er = mk(erConn);

const bookPda = pda([Buffer.from("book"), MINT.toBuffer()]);
const racePda = pda([Buffer.from("race"), MINT.toBuffer()]);
const vaultAuthority = pda([Buffer.from("vault"), MINT.toBuffer()]);
const vaultToken = getAssociatedTokenAddressSync(MINT, vaultAuthority, true);

console.log("PADDOCK HOUSE SETUP");
console.log("  program        ", PROGRAM_ID.toBase58());
console.log("  mint (wSOL)    ", MINT.toBase58());
console.log("  house wallet   ", house.publicKey.toBase58(), `(${walletPath})`);
console.log("  L1             ", BASE_RPC);
console.log("  ER             ", ER_RPC);
console.log("  validator      ", VALIDATOR.toBase58());
console.log("  price feed     ", BTC_FEED.toBase58());
console.log("  book  PDA      ", bookPda.toBase58());
console.log("  race  PDA      ", racePda.toBase58());
console.log("  vault PDA      ", vaultAuthority.toBase58());
console.log("  vault ATA      ", vaultToken.toBase58());
console.log(
  "  house balance  ",
  (await baseConn.getBalance(house.publicKey)) / anchor.web3.LAMPORTS_PER_SOL,
  "SOL"
);
console.log("");
console.log("GRID (client DEFAULT_GRID -> on-chain entrants/strengths)");
console.log("  slot  entrant  car          rarity  client strength  u16");
ROSTER.forEach((c, i) => {
  console.log(
    `  ${String(i).padEnd(4)}  ${String(ENTRANTS[i]).padEnd(7)}  ${c.name.padEnd(11)}  ` +
      `${String(c.rarity).padEnd(6)}  ${STRENGTH[c.rarity].toFixed(2).padEnd(15)}  ${STRENGTHS[i]}`
  );
});
console.log("  entrants :", JSON.stringify(ENTRANTS));
console.log("  strengths:", JSON.stringify(STRENGTHS));
console.log("");

// --- 1. init_book -------------------------------------------------------------
const bookInfo = await baseConn.getAccountInfo(bookPda);
if (bookInfo) {
  const b = await l1.account.book.fetch(bookPda);
  console.log("[1/4] init_book      SKIP — book exists");
  console.log("        authority", b.authority.toBase58());
  console.log("        validator", b.validator.toBase58());
  console.log("        balance  ", b.balance.toString(), " locked", b.locked.toString());
  if (!b.validator.equals(VALIDATOR)) {
    console.error(
      `        FATAL: book pins validator ${b.validator.toBase58()}, expected ` +
        `${VALIDATOR.toBase58()} — delegate_race would fail ValidatorMismatch.`
    );
    process.exit(1);
  }
  if (!b.authority.equals(house.publicKey)) {
    console.error(
      `        FATAL: book authority is ${b.authority.toBase58()}, not this house wallet ` +
        `— the init_book race was lost to someone else.`
    );
    process.exit(1);
  }
} else {
  const sig = await sendIxHttp(
    baseConn,
    l1.methods.initBook(VALIDATOR).accounts({
      authority: house.publicKey,
      mint: MINT,
      book: bookPda,
      vaultAuthority,
      vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }),
    house
  );
  console.log("[1/4] init_book      CREATED", sig);
}

// --- 2. init_race -------------------------------------------------------------
let raceInfo = await baseConn.getAccountInfo(racePda);
if (raceInfo) {
  console.log(
    `[2/4] init_race      SKIP — race exists (L1 owner ${raceInfo.owner.toBase58()})`
  );
} else {
  const sig = await sendIxHttp(
    baseConn,
    l1.methods.initRace(ENTRANTS, STRENGTHS).accounts({
      authority: house.publicKey,
      mint: MINT,
      book: bookPda,
      race: racePda,
      priceUpdate: BTC_FEED,
      systemProgram: SystemProgram.programId,
    }),
    house
  );
  console.log("[2/4] init_race      CREATED", sig);
  raceInfo = await baseConn.getAccountInfo(racePda);
}

// --- 3. delegate_race ---------------------------------------------------------
if (raceInfo && raceInfo.owner.equals(DELEGATION_PROGRAM)) {
  console.log("[3/4] delegate_race  SKIP — race already owned by the delegation program");
} else {
  const sig = await sendIxHttp(
    baseConn,
    l1.methods
      .delegateRace()
      .accounts({ payer: house.publicKey, mint: MINT, book: bookPda, race: racePda })
      .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
    house
  );
  console.log("[3/4] delegate_race  SENT", sig);
  let delegated = false;
  for (let i = 0; i < 30; i++) {
    const info = await baseConn.getAccountInfo(racePda);
    if (info && info.owner.equals(DELEGATION_PROGRAM)) {
      delegated = true;
      break;
    }
    await sleep(1000);
  }
  if (!delegated) {
    console.error("        FATAL: race never took delegation-program ownership on L1");
    process.exit(1);
  }
  console.log("        delegated — L1 owner is now the delegation program");
}

// The Race is only readable in the ER once delegation has landed there.
let erRace = null;
for (let i = 0; i < 30; i++) {
  erRace = await er.account.race.fetchNullable(racePda);
  if (erRace) break;
  await sleep(1000);
}
if (!erRace) {
  console.error("FATAL: Race is not readable in the ER");
  process.exit(1);
}

// --- 4. schedule_race_crank (ER) ---------------------------------------------
// No readable task account exists, so ask the chain the only honest question:
// is anything moving this Race without a client transaction? Watch until the
// committed phase deadline has passed plus a grace margin. A live 1s crank must
// either advance the phase or slide phase_ends_ts (the anti-grinding band slide,
// lib.rs:266) inside that window; both are movement, and only the scheduler can
// cause them here because this script never calls race_crank.
const key = (r) => `${r.seq}:${r.phase}:${r.phaseEndsTs}`;
const nowSecs = () => Math.floor(Date.now() / 1000);
const k0 = key(erRace);
const watchSecs = Math.max(0, erRace.phaseEndsTs.toNumber() - nowSecs()) + 8;
console.log(
  `[4/4] crank          probing — race is ${PHASE_NAME[erRace.phase]} seq ${erRace.seq}, ` +
    `deadline in ${erRace.phaseEndsTs.toNumber() - nowSecs()}s; watching ${watchSecs}s for ` +
    `unattended movement`
);
let live = false;
for (let i = 0; i < watchSecs; i++) {
  await sleep(1000);
  const r = await er.account.race.fetch(racePda);
  if (key(r) !== k0) {
    live = true;
    erRace = r;
    console.log(
      `        MOVED after ${i + 1}s -> seq ${r.seq} ${PHASE_NAME[r.phase]} ` +
        `ends ${r.phaseEndsTs.toString()} — a crank is already running`
    );
    break;
  }
}
if (live) {
  console.log("[4/4] schedule_race_crank  SKIP — the armed task is executing");
} else {
  const sig = await sendIxHttp(
    erConn,
    er.methods
      .scheduleRaceCrank(new BN(TASK_ID), new BN(CRANK_INTERVAL_MS), new BN(CRANK_ITERATIONS))
      .accounts({
        magicProgram: MAGIC_PROGRAM,
        payer: house.publicKey,
        race: racePda,
        priceUpdate: BTC_FEED,
      }),
    house
  );
  console.log(
    `[4/4] schedule_race_crank  ARMED task ${TASK_ID}, ${CRANK_INTERVAL_MS}ms x ` +
      `${CRANK_ITERATIONS} — ${sig}`
  );
  console.log(
    "        (no on-chain task record exists to read; if the scheduler turns out to be " +
      "silent, a re-run will arm again rather than detect the previous arm)"
  );
}

// --- verification -------------------------------------------------------------
console.log("");
console.log("VERIFY");
const l1Race = await baseConn.getAccountInfo(racePda);
console.log(
  "  L1 race owner  ",
  l1Race ? l1Race.owner.toBase58() : "MISSING",
  l1Race && l1Race.owner.equals(DELEGATION_PROGRAM) ? "(delegated)" : "(NOT delegated)"
);
const l1Book = await l1.account.book.fetch(bookPda);
console.log("  L1 book        ", `authority ${l1Book.authority.toBase58()}`);
console.log("  L1 book        ", `validator ${l1Book.validator.toBase58()}`);
const vaultInfo = await baseConn.getAccountInfo(vaultToken);
console.log("  L1 vault ATA   ", vaultInfo ? `exists, ${vaultInfo.data.length}B` : "MISSING");

const r = await er.account.race.fetch(racePda);
console.log("  ER race        ", `seq ${r.seq} phase ${PHASE_NAME[r.phase]} (${r.phase})`);
console.log(
  "  ER phase ends  ",
  `${r.phaseEndsTs.toString()} (${r.phaseEndsTs.toNumber() - nowSecs()}s from now)`
);
console.log("  ER entrants    ", JSON.stringify([...r.entrants]));
console.log("  ER strengths   ", JSON.stringify([...r.strengths]));
console.log("  ER pools       ", JSON.stringify(r.pools.map((p) => p.toString())));
console.log("  ER total       ", r.total.toString());
console.log("  ER order       ", JSON.stringify([...r.order]));
console.log(
  "  ER seed        ",
  [...r.seed].every((b) => b === 0) ? "zero (no lock yet this race)" : Buffer.from(r.seed).toString("hex")
);
console.log("  ER feed        ", r.feed.toBase58());
console.log("  ER rake        ", r.rakeAccrued.toString());
process.exit(0);
