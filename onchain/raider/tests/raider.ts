// Task 10 — THE CANONICAL END-TO-END DRIVER for the raider on-chain game loop.
//
// One unbroken run of the full money + settlement loop, base L1 <-> MagicBlock ER:
//
//   createMint(6dec)
//     -> init_house              (shared house ledger + program-owned USDC vault)
//     -> fund_house(>= max_payout) (real USDC capital into the vault, L1)
//     -> buy_in(player)          (real USDC owner->vault, credit play balance, L1)
//     -> init_round              (idle Round PDA, L1)
//     -> delegate_session        (co-delegate player+house+round to the ER)
//     -> open  (ER)              (entry snapshot, debit stake, pre-lock 23.75x)
//     -> close (ER)              (settle at exit, conserve, write fairness record)
//     -> commit_and_undelegate   (land final ER state on L1, return ownership)
//     -> withdraw(owner)         (real USDC vault->owner ATA, owner-only)
//
// Six load-bearing asserts (ALL must be green):
//   1. all three delegated owners flip to the delegation program, then RESTORE to
//      the raider program after commit_and_undelegate.
//   2. open LOCKS max_payout (23.75x) and DEBITS exactly `stake`.
//   3. close CONSERVES value (player+house.balance+house.locked identical before
//      open and after close) AND on-chain round.payout equals a BigInt settleTs()
//      mirror of settle.rs recomputed from stored (dir,lev,stake,entry_raw,exit_raw).
//   4. after commit_and_undelegate the FINAL balances are durable on L1 (fetched
//      from the base provider, not the ER) and equal the ER's committed values.
//   5. withdraw returns REAL USDC to the owner's ATA (owner-only); the play
//      balance and the vault token balance both drop by the withdrawn amount.
//   6. a NON-OWNER withdraw against the player PDA is REJECTED (ConstraintSeeds /
//      has_one — a stranger derives a different PDA than the victim's).
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getAccount,
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
const MAX_PAYOUT = 23_750_000; // max_payout(1e6) = stake * 25 * 0.95
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// BigInt integer MIRROR of programs/raider/src/settle.rs — proves anyone can
// recompute the payout from on-chain data alone (truncating BigInt division
// mirrors Rust i128/u128 integer division). Outcome codes: 0 cashout/1 cap/2 liq.
// ---------------------------------------------------------------------------
const SCALE = 1_000_000n;
const EDGE_FP = 50_000n;
const LIQ_FP = 200_000n;
const CAP_FP = 25_000_000n;

function equityFp(dir, lev, entryRaw, exitRaw) {
  const ratio = (exitRaw * SCALE) / entryRaw;
  let eq = SCALE + dir * lev * (ratio - SCALE);
  if (eq < 0n) eq = 0n;
  return eq;
}
function terminal(eq) {
  if (eq <= LIQ_FP) return { code: 2, settled: 0n };
  if (eq >= CAP_FP) return { code: 1, settled: CAP_FP };
  return { code: 0, settled: eq };
}
function payoutFp(stake, settledEqFp) {
  return (stake * settledEqFp * (SCALE - EDGE_FP)) / SCALE / SCALE;
}
function settleTs(dir, lev, stake, entryRaw, exitRaw) {
  const t = terminal(equityFp(BigInt(dir), BigInt(lev), BigInt(entryRaw), BigInt(exitRaw)));
  return { outcome: t.code, payout: payoutFp(BigInt(stake), t.settled) };
}

describe("raider — canonical end-to-end loop (L1 <-> ER, real USDC, provable fairness)", function () {
  this.timeout(1_000_000);

  const funder = anchor.Wallet.local(); // ANCHOR_WALLET: pays fees/rent, house authority
  const baseConn = new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" });
  const baseProvider = new anchor.AnchorProvider(baseConn, funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider); // L1 view

  before(() => {
    console.log("base    :", BASE_RPC);
    console.log("ER      :", ER_RPC);
    console.log("funder  :", funder.publicKey.toBase58());
    console.log("validator:", VALIDATOR.toBase58());
    console.log("program :", program.programId.toBase58());
  });

  it("runs the whole loop: mint -> house -> buy_in -> delegate -> open -> close -> commit/undelegate -> withdraw", async () => {
    const conn = baseConn;

    // Fresh session owner (player) so player/round start program-owned this run.
    const session = Keypair.generate();
    await baseProvider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey, toPubkey: session.publicKey,
          lamports: 0.2 * LAMPORTS_PER_SOL,
        })));
    const sessionProvider = new anchor.AnchorProvider(
      conn, new anchor.Wallet(session), { commitment: "confirmed" });
    const programAsSession = new anchor.Program(idl, sessionProvider);

    // ---- createMint(6 dec) ----
    const mint = await createMint(conn, funder.payer, funder.publicKey, null, 6);
    const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    const [playerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()], program.programId);
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), session.publicKey.toBuffer()], program.programId);
    console.log("session :", session.publicKey.toBase58());
    console.log("mint    :", mint.toBase58());
    console.log("PDAs    : player", playerPda.toBase58(), "| house", housePda.toBase58(), "| round", roundPda.toBase58());

    // ---- init_house ----
    await program.methods.initHouse().accounts({
      authority: funder.publicKey, mint, house: housePda, vaultAuthority, vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    // ---- fund_house (>= one round's max_payout) ----
    const HOUSE_FUND = 30_000_000; // 30 USDC, headroom over the 23.75 pre-lock
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, funder.publicKey);
    await mintTo(conn, funder.payer, mint, funderAta.address, funder.publicKey, HOUSE_FUND);
    await program.methods.fundHouse(new BN(HOUSE_FUND)).accounts({
      funder: funder.publicKey, mint, house: housePda, funderToken: funderAta.address,
      vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc({ skipPreflight: true });

    // ---- buy_in (player deposits real USDC) ----
    const BUY_IN = 5_000_000; // 5 USDC
    const ownerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, session.publicKey);
    await mintTo(conn, funder.payer, mint, ownerAta.address, funder.publicKey, BUY_IN);
    await programAsSession.methods.buyIn(new BN(BUY_IN)).accounts({
      owner: session.publicKey, mint, player: playerPda, ownerToken: ownerAta.address,
      vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    // ---- init_round ----
    await programAsSession.methods.initRound().accounts({
      owner: session.publicKey, round: roundPda, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    // ---- delegate_session (co-delegate all three to the ER) ----
    await programAsSession.methods.delegateSession().accounts({
      payer: session.publicKey, mint, player: playerPda, house: housePda, round: roundPda,
    }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
      .rpc({ skipPreflight: true });

    // --- ASSERT 1a: all three owners flip to the delegation program ---
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
    assert.ok(flipped.player && flipped.house && flipped.round,
      `[1a] not all delegated: ${JSON.stringify(flipped)}`);
    console.log("[1a] all three PDAs delegated (owner = delegation program)");

    // ER provider (wallet = session = player_authority).
    const erProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(session), { commitment: "confirmed" });
    const programER = new anchor.Program(idl, erProvider);

    const sumBalances = async () => {
      const p = await programER.account.playerBalance.fetch(playerPda);
      const h = await programER.account.houseBalance.fetch(housePda);
      return BigInt(p.balance.toString()) + BigInt(h.balance.toString()) + BigInt(h.locked.toString());
    };

    // CONSERVATION baseline before open.
    const totalBefore = await sumBalances();
    const playerBeforeOpen = BigInt((await programER.account.playerBalance.fetch(playerPda)).balance.toString());
    console.log("total (player+house.balance+house.locked) BEFORE open:", totalBefore.toString());

    // ---- open(long, 100x, 1 USDC) on the ER ----
    await programER.methods.open(1, 100, new BN(STAKE)).accounts({
      player: playerPda, house: housePda, round: roundPda, mint,
      priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
    }).signers([session]).rpc({ skipPreflight: true });

    const opened = await programER.account.round.fetch(roundPda);
    const houseOpen = await programER.account.houseBalance.fetch(housePda);
    const playerAfterOpen = BigInt((await programER.account.playerBalance.fetch(playerPda)).balance.toString());
    const entryUsd = opened.entryRaw.toNumber() * Math.pow(10, -Math.abs(opened.entryExpo));
    console.log(`opened: status=${opened.status} dir=${opened.dir} lev=${opened.lev} ` +
      `entry_raw=${opened.entryRaw.toString()} (~$${entryUsd.toFixed(2)}) house.locked=${houseOpen.locked.toString()}`);

    // --- ASSERT 2: open locks max_payout and debits exactly stake ---
    assert.equal(opened.status, 1, "[2] round must be open");
    assert.equal(houseOpen.locked.toString(), MAX_PAYOUT.toString(), "[2] house must pre-lock 23.75x");
    assert.equal((playerBeforeOpen - playerAfterOpen).toString(), STAKE.toString(), "[2] player debited exactly stake");
    console.log("[2] open locked 23.75x and debited exactly the stake");

    const playerBeforeClose = BigInt((await programER.account.playerBalance.fetch(playerPda)).balance.toString());

    // Sample a few ticks so the exit mark can differ from entry.
    await sleep(6000);

    // ---- close on the ER ----
    await programER.methods.close().accounts({
      player: playerPda, house: housePda, round: roundPda, mint,
      priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
    }).signers([session]).rpc({ skipPreflight: true });

    const settled = await programER.account.round.fetch(roundPda);
    const playerAfterClose = BigInt((await programER.account.playerBalance.fetch(playerPda)).balance.toString());
    const playerDelta = playerAfterClose - playerBeforeClose;
    const exitUsd = settled.exitRaw.toNumber() * Math.pow(10, -Math.abs(opened.entryExpo));
    const outName = ["cashout", "cap", "liq"][settled.outcome];
    console.log(`closed: status=${settled.status} outcome=${settled.outcome}(${outName}) ` +
      `exit_raw=${settled.exitRaw.toString()} (~$${exitUsd.toFixed(2)}) ` +
      `on-chain payout=${settled.payout.toString()} player credited=${playerDelta.toString()}`);
    console.log(`  ROUND PROOF: dir=${settled.dir} lev=${settled.lev} stake=${settled.stake.toString()} ` +
      `entry_raw=${settled.entryRaw.toString()} exit_raw=${settled.exitRaw.toString()}`);

    assert.equal(settled.status, 2, "round must be settled");

    // --- ASSERT 3a: provable fairness — BigInt mirror == on-chain payout & player delta ---
    const recomputed = settleTs(
      settled.dir, settled.lev, settled.stake.toNumber(),
      settled.entryRaw.toString(), settled.exitRaw.toString());
    console.log(`  settleTs() BigInt recompute: outcome=${recomputed.outcome} payout=${recomputed.payout.toString()}`);
    assert.equal(recomputed.payout.toString(), settled.payout.toString(),
      "[3] BigInt settleTs payout must equal on-chain round.payout");
    assert.equal(recomputed.payout.toString(), playerDelta.toString(),
      "[3] BigInt settleTs payout must equal the player's credited delta");
    assert.equal(recomputed.outcome, settled.outcome,
      "[3] BigInt settleTs outcome must equal the stored on-chain outcome");
    assert.ok(BigInt(settled.payout.toString()) <= BigInt(MAX_PAYOUT),
      "[3] payout must not exceed the house pre-lock");

    // --- ASSERT 3b: conservation across player+house, before open == after close ---
    const totalAfterClose = await sumBalances();
    console.log("total (player+house.balance+house.locked) AFTER close:", totalAfterClose.toString());
    assert.equal(totalAfterClose.toString(), totalBefore.toString(),
      "[3] value conserved across player+house (before open == after close)");
    const houseClose = await programER.account.houseBalance.fetch(housePda);
    assert.equal(houseClose.locked.toString(), "0", "[3] house lock must be released after close");
    console.log("[3] close conserved value AND matches the BigInt settle.rs recompute");

    // Snapshot the ER's final committed values for the L1 cross-check.
    const erPlayerFinal = BigInt((await programER.account.playerBalance.fetch(playerPda)).balance.toString());
    const erHouseFinal = await programER.account.houseBalance.fetch(housePda);

    // ---- commit_and_undelegate (land final ER state on L1, restore ownership) ----
    await programER.methods.commitAndUndelegate().accounts({
      payer: session.publicKey, player: playerPda, house: housePda, round: roundPda, mint,
    }).signers([session]).rpc({ skipPreflight: true });

    // --- ASSERT 1b: all three owners restore to the raider program on L1 ---
    let restored = {};
    for (let i = 0; i < 40; i++) {
      restored = {};
      for (const [name, pda] of Object.entries(targets)) {
        const info = await conn.getAccountInfo(pda);
        restored[name] = info && info.owner.toBase58() === program.programId.toBase58();
      }
      if (restored.player && restored.house && restored.round) break;
      await sleep(2000);
    }
    assert.ok(restored.player && restored.house && restored.round,
      `[1b] not all undelegated within 80s: ${JSON.stringify(restored)}`);
    console.log("[1b] all three PDAs undelegated (owner restored to raider program)");

    // --- ASSERT 4: final balances durable on L1 (fetched from base provider) ---
    const l1Player = BigInt((await program.account.playerBalance.fetch(playerPda)).balance.toString());
    const l1House = await program.account.houseBalance.fetch(housePda);
    const l1Round = await program.account.round.fetch(roundPda);
    console.log(`L1 after commit: player=${l1Player.toString()} house.balance=${l1House.balance.toString()} ` +
      `house.locked=${l1House.locked.toString()} round.status=${l1Round.status} round.payout=${l1Round.payout.toString()}`);
    assert.equal(l1Player.toString(), erPlayerFinal.toString(), "[4] L1 player balance must equal the ER's committed value");
    assert.equal(l1House.balance.toString(), erHouseFinal.balance.toString(), "[4] L1 house.balance must equal ER committed");
    assert.equal(l1House.locked.toString(), "0", "[4] L1 house.locked must be 0 after a settled round");
    assert.equal(l1Round.status, 2, "[4] L1 round.status must be settled");
    assert.equal(l1Round.payout.toString(), settled.payout.toString(), "[4] L1 round.payout must equal the committed payout");
    console.log("[4] final balances are durable on L1 and equal the ER's committed state");

    // --- ASSERT 5: withdraw returns real USDC to the owner (owner-only) ---
    const WITHDRAW = STAKE; // pull 1 USDC of play balance back to real USDC
    const ownerUsdcBefore = BigInt((await getAccount(conn, ownerAta.address)).amount.toString());
    const vaultBefore = BigInt((await getAccount(conn, vaultToken)).amount.toString());
    await programAsSession.methods.withdraw(new BN(WITHDRAW)).accounts({
      owner: session.publicKey, mint, player: playerPda, vaultAuthority, vaultToken,
      ownerToken: ownerAta.address, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc({ skipPreflight: true });
    const ownerUsdcAfter = BigInt((await getAccount(conn, ownerAta.address)).amount.toString());
    const vaultAfter = BigInt((await getAccount(conn, vaultToken)).amount.toString());
    const l1PlayerAfterWd = BigInt((await program.account.playerBalance.fetch(playerPda)).balance.toString());
    console.log(`withdraw ${WITHDRAW}: owner USDC ${ownerUsdcBefore.toString()} -> ${ownerUsdcAfter.toString()} ` +
      `| vault ${vaultBefore.toString()} -> ${vaultAfter.toString()} | play balance -> ${l1PlayerAfterWd.toString()}`);
    assert.equal((ownerUsdcAfter - ownerUsdcBefore).toString(), WITHDRAW.toString(), "[5] owner ATA must receive the withdrawn USDC");
    assert.equal((vaultBefore - vaultAfter).toString(), WITHDRAW.toString(), "[5] vault must release exactly the withdrawn USDC");
    assert.equal((l1Player - l1PlayerAfterWd).toString(), WITHDRAW.toString(), "[5] play balance must drop by the withdrawn amount");
    console.log("[5] withdraw returned real USDC to the owner (owner-only)");

    // --- ASSERT 6: a NON-OWNER withdraw against the player PDA is REJECTED ---
    const attacker = Keypair.generate();
    await baseProvider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey, toPubkey: attacker.publicKey,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        })));
    const attackerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, attacker.publicKey);
    const attackerProvider = new anchor.AnchorProvider(
      conn, new anchor.Wallet(attacker), { commitment: "confirmed" });
    const programAsAttacker = new anchor.Program(idl, attackerProvider);

    let wRejected = false, wErr = "";
    try {
      // Attacker passes the VICTIM's player PDA but signs as themselves. Anchor
      // re-derives [player, attacker, mint] != the victim's PDA -> ConstraintSeeds.
      await programAsAttacker.methods.withdraw(new BN(STAKE)).accounts({
        owner: attacker.publicKey, mint, player: playerPda, vaultAuthority, vaultToken,
        ownerToken: attackerAta.address, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
    } catch (e) {
      wRejected = true;
      wErr = (e && e.toString()) || "";
    }
    assert.ok(wRejected, "[6] a non-owner withdraw MUST be rejected");
    assert.ok(/ConstraintSeeds|2006|has[_ ]?one|NotOwner/i.test(wErr),
      "[6] rejection must be a seeds/owner constraint, got:\n  " + wErr.split("\n").slice(0, 6).join("\n  "));
    console.log("[6] non-owner withdraw REJECTED (seeds/owner constraint) — funds are non-custodial");

    console.log("\nALL 6 END-TO-END ASSERTS GREEN — full on-chain loop verified.");
  });
});
