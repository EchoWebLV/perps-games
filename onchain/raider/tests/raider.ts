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

const {
  BASE_RPC,
  ER_RPC,
  ER_WS,
  BTC_FEED,
  VALIDATOR,
  sleep,
  settleSeq,
  deriveTill,
  maxPayout,
} = require("./helpers");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const STAKE = 1_000_000; // 1 USDC
const MAX_PAYOUT = 23_750_000; // max_payout(1e6) = stake * 25 * 0.95

// ---------------------------------------------------------------------------
// BigInt integer MIRROR of programs/raider/src/settle.rs — proves anyone can
// recompute the payout from on-chain data alone. settleTs is the Phase-1
// single-leg view of the shared banked-aware settle mirror in ./helpers:
// settleSeq with NO mid-round actions reduces EXACTLY to it (truncating BigInt
// division mirrors Rust i128/u128). Outcome codes: 0 cashout/1 cap/2 liq.
// ---------------------------------------------------------------------------
const settleTs = (dir, lev, stake, entryRaw, exitRaw) =>
  settleSeq(stake, dir, lev, entryRaw, [], exitRaw);

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
    const [masterPda] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], program.programId);
    const till = deriveTill(program.programId, mint, session.publicKey); // per-session till (was the shared house)
    // Multi-asset feed registry PDA `[b"feeds"]` (admin-owned, already set on devnet). open()
    // binds asset -> feed via it; asset 0 = BTC = BTC_FEED. (Deployed program upgraded past the
    // 3-arg open this test was written against — open now takes (asset,dir,lev,stake) + registry.)
    const [feedRegistry] = PublicKey.findProgramAddressSync([Buffer.from("feeds")], program.programId);
    const ASSET_BTC = 0;
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    const [playerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()], program.programId);
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), session.publicKey.toBuffer()], program.programId);
    console.log("session :", session.publicKey.toBase58());
    console.log("mint    :", mint.toBase58());
    console.log("PDAs    : player", playerPda.toBase58(), "| house", masterPda.toBase58(), "| till", till.toBase58(), "| round", roundPda.toBase58());

    // ---- init_house (the program applies its bounded per-session slice ceiling) ----
    await program.methods.initHouse().accounts({
      authority: funder.publicKey, mint, house: masterPda, vaultAuthority, vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    // ---- fund_house (>= one round's max_payout) ----
    const HOUSE_FUND = 30_000_000; // 30 USDC, headroom over the 23.75 pre-lock
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, funder.publicKey);
    await mintTo(conn, funder.payer, mint, funderAta.address, funder.publicKey, HOUSE_FUND);
    await program.methods.fundHouse(new BN(HOUSE_FUND)).accounts({
      funder: funder.publicKey, mint, house: masterPda, funderToken: funderAta.address,
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

    // ---- slice_from_pot (carve this session's bet-sized till off the master, L1, PRE-delegate) ----
    // The master `[house, mint]` is the funded bankroll; slice max_payout(STAKE) into the till
    // `[house, mint, session]`, which is what delegate_session co-delegates to the ER.
    await programAsSession.methods.sliceFromPot(new BN(maxPayout(STAKE))).accounts({
      owner: session.publicKey, mint, master: masterPda, till, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    // ---- delegate_session (co-delegate player + till + round to the ER) ----
    await programAsSession.methods.delegateSession().accounts({
      payer: session.publicKey, mint, player: playerPda, house: till, round: roundPda,
    }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
      .rpc({ skipPreflight: true });

    // --- ASSERT 1a: all three owners flip to the delegation program ---
    // NB: it's the per-session TILL (not the master pot) that co-delegates with player+round.
    const targets = { player: playerPda, house: till, round: roundPda };
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

    // The house-side ledger the ER settles against is the delegated TILL, not the master.
    const sumBalances = async () => {
      const p = await programER.account.playerBalance.fetch(playerPda);
      const h = await programER.account.houseBalance.fetch(till);
      return BigInt(p.balance.toString()) + BigInt(h.balance.toString()) + BigInt(h.locked.toString());
    };

    // CONSERVATION baseline before open.
    const totalBefore = await sumBalances();
    const playerBeforeOpen = BigInt((await programER.account.playerBalance.fetch(playerPda)).balance.toString());
    console.log("total (player+house.balance+house.locked) BEFORE open:", totalBefore.toString());

    // ---- open(BTC, long, 100x, 1 USDC) on the ER ----
    await programER.methods.open(ASSET_BTC, 1, 100, new BN(STAKE), new BN(0), 0, 0, 0, 0, 0).accounts({
      player: playerPda, house: till, round: roundPda, mint,
      priceUpdate: BTC_FEED, registry: feedRegistry, playerAuthority: session.publicKey,
    }).signers([session]).rpc({ skipPreflight: true });

    const opened = await programER.account.round.fetch(roundPda);
    const houseOpen = await programER.account.houseBalance.fetch(till);
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
      player: playerPda, house: till, round: roundPda, mint,
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
    const houseClose = await programER.account.houseBalance.fetch(till);
    assert.equal(houseClose.locked.toString(), "0", "[3] house lock must be released after close");
    console.log("[3] close conserved value AND matches the BigInt settle.rs recompute");

    // Snapshot the ER's final committed values for the L1 cross-check (till, not master).
    const erPlayerFinal = BigInt((await programER.account.playerBalance.fetch(playerPda)).balance.toString());
    const erHouseFinal = await programER.account.houseBalance.fetch(till);

    // --- ASSERT 1a-neg (FIX 1): a NON-OWNER cannot undelegate the still-delegated session ---
    // The three PDAs are still ER-delegated here. commit_and_undelegate is now OWNER-ONLY:
    // an attacker who passes the VICTIM's PDAs but signs as themselves has
    // payer.key() != player.owner, so the require_keys_eq! rejects with NotOwner. Before the
    // fix this call tore the victim's live session back to L1, wedging their round and the
    // locked house capital. (Runs in the ER; funded on L1 for the ER fee payer.)
    const undelegAttacker = Keypair.generate();
    await baseProvider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey, toPubkey: undelegAttacker.publicKey,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        })));
    const attackerErProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
      new anchor.Wallet(undelegAttacker), { commitment: "confirmed" });
    const programErAttacker = new anchor.Program(idl, attackerErProvider);
    let udRejected = false, udErr = "";
    try {
      await programErAttacker.methods.commitAndUndelegate().accounts({
        payer: undelegAttacker.publicKey, player: playerPda, house: till, round: roundPda, mint,
      }).signers([undelegAttacker]).rpc({ skipPreflight: true });
    } catch (e) {
      udRejected = true;
      udErr = (e && e.toString()) || "";
    }
    assert.ok(udRejected, "[1a-neg] a non-owner commit_and_undelegate MUST be rejected");
    assert.ok(/NotOwner|6007/i.test(udErr),
      "[1a-neg] rejection must be the owner check (NotOwner=6007), got:\n  " + udErr.split("\n").slice(0, 6).join("\n  "));
    // The attack must NOT have torn down the session — the PDAs are still delegation-owned.
    for (const [name, pda] of Object.entries(targets)) {
      const info = await conn.getAccountInfo(pda);
      assert.equal(info.owner.toBase58(), DELEGATION_PROGRAM.toBase58(),
        `[1a-neg] ${name} must still be delegated after the rejected undelegate`);
    }
    console.log("[1a-neg] non-owner undelegate REJECTED (NotOwner); session still delegated");

    // ---- commit_and_undelegate (land final ER state on L1, restore ownership) ----
    await programER.methods.commitAndUndelegate().accounts({
      payer: session.publicKey, player: playerPda, house: till, round: roundPda, mint,
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
    // The committed house ledger is the TILL (what was delegated); the master pot is the
    // untouched-on-L1 remainder of the bankroll (fetched too, for the 4b reconciliation).
    const l1Player = BigInt((await program.account.playerBalance.fetch(playerPda)).balance.toString());
    const l1House = await program.account.houseBalance.fetch(till);
    const l1Master = await program.account.houseBalance.fetch(masterPda);
    const l1Round = await program.account.round.fetch(roundPda);
    console.log(`L1 after commit: player=${l1Player.toString()} house.balance=${l1House.balance.toString()} ` +
      `house.locked=${l1House.locked.toString()} round.status=${l1Round.status} round.payout=${l1Round.payout.toString()}`);
    assert.equal(l1Player.toString(), erPlayerFinal.toString(), "[4] L1 player balance must equal the ER's committed value");
    assert.equal(l1House.balance.toString(), erHouseFinal.balance.toString(), "[4] L1 house.balance must equal ER committed");
    assert.equal(l1House.locked.toString(), "0", "[4] L1 house.locked must be 0 after a settled round");
    assert.equal(l1Round.status, 2, "[4] L1 round.status must be settled");
    assert.equal(l1Round.payout.toString(), settled.payout.toString(), "[4] L1 round.payout must equal the committed payout");
    console.log("[4] final balances are durable on L1 and equal the ER's committed state");

    // --- ASSERT 4b: VAULT RECONCILIATION — real custody covers the ledger ---
    // The program-owned USDC vault token balance must be >= the sum of every
    // play-balance claim against it (player.balance + the whole house side). Under the
    // till model the house side is split master + till, so BOTH count as claims. The
    // ledger can never promise more USDC than is actually custodied. (house.locked is a
    // RESERVATION of till.balance, not an extra claim, so it is not added here.)
    const vaultCustody = BigInt((await getAccount(conn, vaultToken)).amount.toString());
    const ledgerClaims = l1Player + BigInt(l1Master.balance.toString()) + BigInt(l1House.balance.toString());
    console.log(`[4b] vault custody=${vaultCustody.toString()} >= ledger claims (player+master+till.balance)=${ledgerClaims.toString()}`);
    assert.ok(vaultCustody >= ledgerClaims,
      `[4b] vault custody (${vaultCustody}) must be >= ledger claims (${ledgerClaims})`);
    console.log("[4b] vault reconciliation OK — real USDC custody >= the play-balance ledger");

    // --- ASSERT 4c: SWEEP the till back into the master; conservation across the pot ---
    // Session over → fold the whole till (slice ± this session's house P&L) back into the
    // master. till.balance goes to 0; master regains the leftover. Signed by the owner
    // (session); permissionless payer path is exercised in the devnet integration test.
    const masterBefore = (await program.account.houseBalance.fetch(masterPda)).balance;
    await programAsSession.methods.sweepTill().accounts({
      payer: session.publicKey, mint, owner: session.publicKey, master: masterPda, till,
    }).rpc({ skipPreflight: true });
    const tillAfter = (await program.account.houseBalance.fetch(till)).balance;
    const masterAfter = (await program.account.houseBalance.fetch(masterPda)).balance;
    console.log(`[4c] sweep: master ${masterBefore.toString()} -> ${masterAfter.toString()} | till -> ${tillAfter.toString()}`);
    assert.equal(tillAfter.toNumber(), 0, "[4c] till must be zeroed after sweep");
    // master regained the till's leftover (slice ± this session's P&L)
    assert.ok(masterAfter.toNumber() > masterBefore.toNumber(),
      `[4c] master must regain the till leftover (before ${masterBefore.toString()} < after ${masterAfter.toString()})`);
    console.log("[4c] sweep_till folded the leftover back into the master pot (conserved)");

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
