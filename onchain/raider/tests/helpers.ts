// Shared test helpers for the raider Anchor suite.
//
// PURE EXTRACTION (no logic changes): the env wiring, the ER send/confirm
// workaround, and the BigInt settle.rs mirror were copy-pasted identically across
// tests/flip.ts, tests/tick-liq.ts, tests/raider.ts and tests/liq.ts. Centralising
// them here keeps every driver settling against the SAME definitions and lets new
// drivers (e.g. tests/lever.ts) reuse them without another copy. CommonJS
// module.exports to match tests/keeper.ts.
const anchor = require("@coral-xyz/anchor");
const { PublicKey } = require("@solana/web3.js");

// --- environment / RPC wiring (devnet + MagicBlock ER defaults) ---
const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
// Pin the base-layer WS endpoint. web3.js auto-derives the WS URL from BASE_RPC, but
// some HTTP providers (e.g. Helius) serve a signature-subscription stream that
// rpc-websockets v9 cannot parse ("Unknown action 'undefined'"), which makes Anchor's
// .rpc() throw even though the tx lands. Pinning a known-good public devnet WS keeps
// Anchor's confirmation path working while HTTP sends go to whatever BASE_RPC is.
const BASE_WS = process.env.BASE_WS || "wss://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const BTC_FEED = new PublicKey(
  process.env.BTC_FEED || "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"
);
const VALIDATOR = new PublicKey(
  process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send + confirm a built Anchor instruction via HTTP polling ONLY (no WS). The
// base-layer `delegate_session` CPI is heavy and its WebSocket confirmation
// intermittently trips a web3.js bug that wraps the WS failure in a malformed
// SendTransactionError ("Unknown action 'undefined'") even though the tx itself
// simulates clean and lands on-chain. We bypass the WS path here: build, sign,
// sendRawTransaction, then poll getSignatureStatuses until confirmed. (The lighter
// init/buy_in/open calls confirm fine over WS, so only this one needs it.)
async function sendIxHttp(conn, methodBuilder, signer) {
  const tx = await methodBuilder.transaction();
  // delegate_session co-delegates 3 PDAs and is near the default 200k CU limit;
  // cold-account loading can push it over (ComputationalBudgetExceeded). Raise it
  // so the heavy delegate tx lands deterministically.
  tx.instructions.unshift(
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })
  );
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (
      st &&
      (st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized")
    ) {
      if (st.err)
        throw new Error("tx " + sig + " failed: " + JSON.stringify(st.err));
      return sig;
    }
    await sleep(1000);
  }
  throw new Error("tx " + sig + " not confirmed within 60s");
}

// --- BigInt sequence mirror of settle.rs (banked-aware) ---
// Truncating BigInt division mirrors Rust i128/u128 integer division. Outcome codes:
// 0 cashout / 1 cap / 2 liq. This is the BANKED-AWARE generalisation of the
// Phase-1 settleTs() mirror: it walks the action sequence, applying the SAME
// terminal-first-then-rebank order the on-chain `flip`/`tick`/`lever` actions use.
// With an EMPTY action list it reduces EXACTLY to the single-leg Phase-1 settle, so
// tests/raider.ts can alias settleTs(dir,lev,stake,entry,exit) onto it unchanged.
const SCALE = 1_000_000n,
  EDGE_FP = 50_000n,
  LIQ_FP = 200_000n,
  CAP_FP = 25_000_000n;
const rebankFp = (b, dir, lev, entry, price) =>
  b + dir * lev * ((price * SCALE) / entry - SCALE);
const equityFpB = (b, dir, lev, entry, exit) => {
  let e = SCALE + rebankFp(b, dir, lev, entry, exit);
  return e < 0n ? 0n : e;
};
const terminal = (eq) =>
  eq <= LIQ_FP
    ? { code: 2, settled: 0n }
    : eq >= CAP_FP
    ? { code: 1, settled: CAP_FP }
    : { code: 0, settled: eq };
const payoutFp = (stake, eq) =>
  (stake * eq * (SCALE - EDGE_FP)) / SCALE / SCALE;
function settleSeq(stake, dir0, lev0, entry0, actions, exitRaw) {
  let b = 0n,
    dir = BigInt(dir0),
    lev = BigInt(lev0),
    entry = BigInt(entry0);
  for (const a of actions) {
    const t = terminal(equityFpB(b, dir, lev, entry, BigInt(a.priceRaw)));
    if (t.code !== 0)
      return { outcome: t.code, payout: payoutFp(BigInt(stake), t.settled) };
    b = rebankFp(b, dir, lev, entry, BigInt(a.priceRaw));
    entry = BigInt(a.priceRaw);
    if (a.kind === "flip") dir = BigInt(a.dir);
    else if (a.kind === "lever") lev = BigInt(a.lev);
  }
  const t = terminal(equityFpB(b, dir, lev, entry, BigInt(exitRaw)));
  return { outcome: t.code, payout: payoutFp(BigInt(stake), t.settled) };
}

// Per-session till PDA `[b"house", mint, owner]` (the master pot is `[b"house", mint]`).
function deriveTill(programId, mint, owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("house"), mint.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}

// Mirror settle::max_payout — floor(stake * 23.75) — the bet-sized slice carved off the pot.
function maxPayout(stake) {
  return Number((BigInt(stake) * 25_000_000n * 950_000n) / 1_000_000n / 1_000_000n);
}

module.exports = {
  BASE_RPC,
  BASE_WS,
  ER_RPC,
  ER_WS,
  BTC_FEED,
  VALIDATOR,
  sleep,
  sendIxHttp,
  SCALE,
  EDGE_FP,
  LIQ_FP,
  CAP_FP,
  rebankFp,
  equityFpB,
  terminal,
  payoutFp,
  settleSeq,
  deriveTill,
  maxPayout,
};
