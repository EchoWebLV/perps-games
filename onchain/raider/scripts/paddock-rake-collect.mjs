// PADDOCK RAKE COLLECTION — turn the rollup's rake counter into house money.
//
// The rake is earned in the ER and lands on L1 as a CUMULATIVE counter inside
// `Race.rake_accrued`. Three things have to happen for the house to actually hold
// it, and this script does all three, idempotently:
//
//   1. commit_race()   ER — publish the rollup's counter to L1. Permissionless.
//   2. sweep_rake()    L1 — diff the committed counter against `book.locked` (the
//                           high-water mark) and credit the delta to
//                           `book.balance`. Permissionless.
//   3. withdraw_rake() L1 — move the real tokens out of the vault ATA into the
//                           house's own token account. AUTHORITY ONLY, and opt-in
//                           here behind `--withdraw`, because it is the only step
//                           that moves value.
//
// Steps 1 and 2 are safe to run at any cadence, from any wallet: repeating them
// credits nothing extra (programs/paddock/src/book.rs, `sweep_rake` — the mark is
// a watermark, so total credit equals the highest committed counter ever seen,
// full stop). Running them when the ER is ahead of L1 simply under-credits and
// the shortfall is picked up by the next run.
//
// Run (report + commit + sweep, no value moves):
//   cd onchain/raider && ANCHOR_WALLET=$HOME/.config/solana/id.json \
//     node scripts/paddock-rake-collect.mjs
//
// Collect the credited rake into the house's ATA as well:
//   ... node scripts/paddock-rake-collect.mjs --withdraw
//
// Flags:
//   --withdraw[=N]  also withdraw; N in base units, default = the whole balance.
//   --no-commit     skip the ER commit and sweep whatever L1 already shows.
//   --dry           report only; send nothing.
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const { BN } = anchor;

const idl = JSON.parse(
  readFileSync(new URL("../target/idl/paddock.json", import.meta.url), "utf8")
);
const PROGRAM_ID = new PublicKey(idl.address);

const BASE_RPC =
  process.env.ANCHOR_PROVIDER_URL || process.env.BASE_RPC || "https://api.devnet.solana.com";
const BASE_WS = process.env.BASE_WS || "wss://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
// wSOL — the client's ACTIVE_STAKE_CURRENCY, same default as paddock-house-setup.mjs.
const MINT = new PublicKey(
  process.env.BOOK_MINT || "So11111111111111111111111111111111111111112"
);
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const argv = process.argv.slice(2);
const has = (f) => argv.some((a) => a === f || a.startsWith(f + "="));
const valOf = (f) => {
  const a = argv.find((x) => x.startsWith(f + "="));
  return a ? a.slice(f.length + 1) : null;
};
const DRY = has("--dry");
const DO_COMMIT = !has("--no-commit");
const DO_WITHDRAW = has("--withdraw");
const WITHDRAW_AMOUNT = valOf("--withdraw"); // null = the whole credited balance

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send + confirm by HTTP polling only — same helper as paddock-house-setup.mjs.
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

// Once the Race is delegated, L1's copy is owned by the DELEGATION program, so
// Anchor's typed fetch refuses it. Decode the raw bytes with the same coder —
// exactly what `sweep_rake` does on chain.
//
// GOTCHA: the key is "race", lower-case, NOT the IDL's "Race". anchor-ts runs
// convertIdlToCamelCase over the IDL inside the Program constructor, so the
// coder is keyed by the camelCased name while `program.rawIdl` keeps the
// original. "Race" throws `Account not found: Race`.
async function readL1Race() {
  const info = await baseConn.getAccountInfo(racePda);
  if (!info) return null;
  return l1.coder.accounts.decode("race", info.data);
}

console.log("PADDOCK RAKE COLLECTION");
console.log("  program        ", PROGRAM_ID.toBase58());
console.log("  mint           ", MINT.toBase58());
console.log("  wallet         ", house.publicKey.toBase58(), `(${walletPath})`);
console.log("  L1             ", BASE_RPC);
console.log("  ER             ", ER_RPC);
console.log("  book  PDA      ", bookPda.toBase58());
console.log("  race  PDA      ", racePda.toBase58());
console.log("  vault ATA      ", vaultToken.toBase58());
console.log(
  "  mode           ",
  DRY ? "DRY — report only" : DO_WITHDRAW ? "commit + sweep + WITHDRAW" : "commit + sweep"
);
console.log("");

const book0 = await l1.account.book.fetchNullable(bookPda);
if (!book0) {
  console.error(`FATAL: no book at ${bookPda.toBase58()} — run paddock-house-setup.mjs first.`);
  process.exit(1);
}
const isAuthority = book0.authority.equals(house.publicKey);

// --- 0. where things stand -----------------------------------------------------
const erRace = await er.account.race.fetchNullable(racePda);
const l1Race0 = await readL1Race();
const vault0 = await getAccount(baseConn, vaultToken).catch(() => null);

console.log("BEFORE");
console.log("  book.authority ", book0.authority.toBase58(), isAuthority ? "(this wallet)" : "");
console.log("  book.balance   ", book0.balance.toString(), " <- credited, unwithdrawn rake");
console.log("  book.locked    ", book0.locked.toString(), " <- high-water mark");
console.log("  L1  rake_accrued", l1Race0 ? l1Race0.rakeAccrued.toString() : "no race account");
console.log("  ER  rake_accrued", erRace ? erRace.rakeAccrued.toString() : "not readable in ER");
console.log("  vault ATA      ", vault0 ? vault0.amount.toString() : "MISSING");
if (erRace && l1Race0) {
  const lag = BigInt(erRace.rakeAccrued.toString()) - BigInt(l1Race0.rakeAccrued.toString());
  console.log(
    "  commit lag     ",
    `${lag} — rake earned in the rollup that L1 has not been told about yet`
  );
}
console.log("");

if (DRY) {
  console.log("DRY — nothing sent.");
  process.exit(0);
}

// --- 1. commit_race (ER) -------------------------------------------------------
if (!DO_COMMIT) {
  console.log("[1/3] commit_race    SKIP — --no-commit");
} else if (!erRace) {
  console.log("[1/3] commit_race    SKIP — the Race is not readable in the ER");
} else {
  const want = BigInt(erRace.rakeAccrued.toString());
  const sig = await sendIxHttp(
    erConn,
    er.methods.commitRace().accounts({ payer: house.publicKey, race: racePda }),
    house
  );
  console.log("[1/3] commit_race    SENT", sig);
  let landed = false;
  for (let i = 0; i < 40; i++) {
    const r = await readL1Race();
    if (r && BigInt(r.rakeAccrued.toString()) >= want) {
      landed = true;
      console.log(`        L1 rake_accrued is now ${r.rakeAccrued.toString()}`);
      break;
    }
    await sleep(2000);
  }
  if (!landed) {
    // Not fatal. The sweep below still credits whatever L1 DOES show, and the
    // rest is picked up next run — that is the whole point of a cumulative
    // counter plus a watermark.
    console.log(
      `        commit has not surfaced on L1 within 80s; sweeping L1's current view anyway`
    );
  }
}

// --- 2. sweep_rake (L1) --------------------------------------------------------
{
  const sig = await sendIxHttp(
    baseConn,
    l1.methods
      .sweepRake()
      .accounts({ payer: house.publicKey, mint: MINT, book: bookPda, race: racePda }),
    house
  );
  const b = await l1.account.book.fetch(bookPda);
  const credited = BigInt(b.balance.toString()) - BigInt(book0.balance.toString());
  console.log("[2/3] sweep_rake     SENT", sig);
  console.log(
    `        credited ${credited} this run — book.balance ${b.balance.toString()}, ` +
      `mark ${b.locked.toString()}`
  );
}

// --- 3. withdraw_rake (L1, authority only) -------------------------------------
const book1 = await l1.account.book.fetch(bookPda);
if (!DO_WITHDRAW) {
  console.log(
    `[3/3] withdraw_rake  SKIP — pass --withdraw to move ${book1.balance.toString()} ` +
      `base units out of the vault`
  );
} else if (!isAuthority) {
  console.error(
    `[3/3] withdraw_rake  FATAL: only ${book0.authority.toBase58()} can withdraw; ` +
      `this wallet is ${house.publicKey.toBase58()}.`
  );
  process.exit(1);
} else {
  const amount = WITHDRAW_AMOUNT ? BigInt(WITHDRAW_AMOUNT) : BigInt(book1.balance.toString());
  if (amount === 0n) {
    console.log("[3/3] withdraw_rake  SKIP — nothing credited to withdraw");
  } else {
    const houseAta = getAssociatedTokenAddressSync(MINT, house.publicKey, false);
    const pre = await getAccount(baseConn, houseAta).catch(() => null);
    if (!pre) {
      console.error(
        `[3/3] withdraw_rake  FATAL: the house has no token account for this mint at ` +
          `${houseAta.toBase58()}. Create it first:\n` +
          `        spl-token create-account ${MINT.toBase58()} --url ${BASE_RPC}`
      );
      process.exit(1);
    }
    const sig = await sendIxHttp(
      baseConn,
      l1.methods.withdrawRake(new BN(amount.toString())).accounts({
        authority: house.publicKey,
        mint: MINT,
        book: bookPda,
        authorityToken: houseAta,
        vaultAuthority,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      house
    );
    const post = await getAccount(baseConn, houseAta);
    console.log("[3/3] withdraw_rake  SENT", sig);
    console.log(
      `        ${houseAta.toBase58()} ${pre.amount} -> ${post.amount} ` +
        `(+${post.amount - pre.amount})`
    );
  }
}

// --- verification --------------------------------------------------------------
const book2 = await l1.account.book.fetch(bookPda);
const l1Race2 = await readL1Race();
const vault2 = await getAccount(baseConn, vaultToken).catch(() => null);
const raceInfo = await baseConn.getAccountInfo(racePda);
console.log("");
console.log("AFTER");
console.log("  book.balance   ", book2.balance.toString());
console.log("  book.locked    ", book2.locked.toString(), " (mark; never decreases)");
console.log("  L1  rake_accrued", l1Race2 ? l1Race2.rakeAccrued.toString() : "n/a");
console.log("  vault ATA      ", vault2 ? vault2.amount.toString() : "MISSING");
console.log(
  "  race L1 owner  ",
  raceInfo ? raceInfo.owner.toBase58() : "MISSING",
  raceInfo && raceInfo.owner.equals(DELEGATION_PROGRAM) ? "(still delegated)" : "(NOT delegated)"
);
if (l1Race2 && book2.locked.toString() !== l1Race2.rakeAccrued.toString()) {
  console.log(
    "  NOTE            mark < committed counter — a later sweep will pick up the rest."
  );
}
process.exit(0);
