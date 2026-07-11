import { describe, it, expect } from "vitest";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import idl from "./idl/raider.json";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import { createChainRound, deriveRaiderPdas, HIGHWAY_DURATION_SENTINEL, isHighwayRound, maxPayoutBase } from "./chain-round";
import { CHAIN, deriveFeedRegistry } from "./config";

const RUN = process.env.RAIDER_DEVNET === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendIxHttp(
  conn: Connection,
  builder: { transaction(): Promise<anchor.web3.Transaction> },
  signer: Keypair,
): Promise<string> {
  const tx = await builder.transaction();
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const status = (await conn.getSignatureStatuses([sig])).value[0];
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      if (status.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
      return sig;
    }
    await sleep(1000);
  }
  throw new Error(`tx ${sig} not confirmed within 60s`);
}

describe.skipIf(!RUN)("chain-round devnet loop", () => {
  it("buy_in -> delegate -> open -> close -> undelegate -> withdraw, conserved + recomputable", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // --- operator setup: fresh mint + house, funded ---
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse(new anchor.BN(0)).accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });

    // --- player: dev-keypair wallet, funded with SOL + test USDC ---
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
    const playerAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey);
    await mintTo(conn, funder, mint, playerAta.address, funder.publicKey, 5_000_000);

    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });

    // --- the loop ---
    await chain.buyIn(5_000_000);
    expect(await chain.readPlayerBalance()).toBe(5_000_000n);
    await chain.ensureRoundInited();
    await chain.sliceFromPot(maxPayoutBase(1_000_000));
    await chain.delegate();

    const opened = await chain.open("BTC", 1, 100, 1_000_000, 60, 200_000); // long, 100x, 1 USDC
    expect(opened.entryHuman).toBeGreaterThan(1000); // BTC in the tens of thousands
    expect(await chain.readRoundStatus(true)).toBe(1); // open on ER

    await sleep(6000); // let the feed move so exit != entry
    const settled = await chain.close();
    expect(["cashout", "cap", "liq", "time"]).toContain(settled.outcomeName);
    // conservation: player balance == (5 - stake) + payout
    expect(settled.balance).toBe(5_000_000n - 1_000_000n + settled.payout);

    await chain.commitAndUndelegate();
    expect(await chain.readRoundStatus(false)).toBe(2); // settled, durable on L1

    const l1Balance = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(l1Balance));
    expect(await chain.readPlayerBalance(false)).toBe(0n);
  }, 180_000);

  it("opens 2000x, flips + levers, then the NATIVE CRANK settles it with zero client close/tick", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // operator: fresh mint + house funded over the 2000x pre-lock (23.75 per round)
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse(new anchor.BN(0)).accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });

    // player: dev-keypair wallet funded with SOL (also pays the crank escrow) + test USDC
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
    const playerAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey);
    await mintTo(conn, funder, mint, playerAta.address, funder.publicKey, 5_000_000);

    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });

    await chain.buyIn(5_000_000);
    await chain.ensureRoundInited();
    await chain.sliceFromPot(maxPayoutBase(1_000_000));
    await chain.delegate();

    // open 2000x, exercise the mid-round actions, then arm the crank
    await chain.open("BTC", 1, 2000, 1_000_000, 60, 200_000);
    expect(await chain.readRoundStatus(true)).toBe(1);
    const afterFlip = await chain.flip(-1);
    if (!afterFlip.settled) expect(afterFlip.dir).toBe(-1); // 2000x could terminal-first; both are valid
    if (!afterFlip.settled) await chain.lever(1000);
    await chain.scheduleCrank({ intervalMs: 1000, iterations: 70 });

    // STOP touching it — poll only. The native crank must drive it to status 2 (zero client close/tick).
    const deadline = Date.now() + 90_000;
    let snap = await chain.readRound(true);
    while (Date.now() < deadline && (!snap || snap.status !== 2)) {
      await sleep(2000);
      snap = await chain.readRound(true);
    }
    expect(snap?.status).toBe(2); // settled by the crank alone
    expect([1, 2, 3]).toContain(snap!.outcome); // cap | liq | time — never cashout(0): no client close ran

    // cleanup: bring it home + withdraw
    await chain.commitAndUndelegate();
    const l1 = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(l1));
    expect(await chain.readPlayerBalance(false)).toBe(0n);
  }, 240_000);

  it("two wallets run concurrent sessions off one pot; conservation holds; a third is rejected", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // operator: fresh mint + master pot funded to cover ~2 min slices, NOT 3.
    // STAKE 1_000_000 -> slice = maxPayoutBase = 23_750_000; fund 50_000_000 (covers 2, not 3).
    const STAKE = 1_000_000;
    const SLICE = maxPayoutBase(STAKE); // 23_750_000
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [master] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse(new anchor.BN(0)).accounts({ authority: funder.publicKey, mint, house: master, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house: master, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });
    // program is constructed from the untyped `Idl` (matches this file's other tests); the
    // account namespace's index type can't be inferred from that, so cast this one read.
    const houseBalanceAt = (pk: PublicKey) => (program.account as unknown as { houseBalance: { fetch(pk: PublicKey): Promise<{ balance: { toString(): string } }> } }).houseBalance.fetch(pk);
    const masterStart = Number((await houseBalanceAt(master)).balance.toString());

    const makePlayer = async () => {
      const kp = Keypair.generate();
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
      const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mint, kp.publicKey);
      await mintTo(conn, funder, mint, ata.address, funder.publicKey, 5_000_000);
      const port = createDevKeypairPort({ secretKey: kp.secretKey, store: { get: () => null, set: () => {} } });
      await port.connect();
      return createChainRound({ wallet: portToAnchorWallet(port), mint });
    };

    const a = await makePlayer();
    const b = await makePlayer();

    // both buy in + init + slice + delegate CONCURRENTLY — neither gets delegate_busy (per-session tills)
    const startSession = async (p: ReturnType<typeof createChainRound>) => {
      await p.buyIn(5_000_000);
      await p.ensureRoundInited();
      await p.sliceFromPot(SLICE);
      await p.delegate();
    };
    await Promise.all([startSession(a), startSession(b)]); // headline: concurrent delegate, no busy

    // pot down by 2 slices -> a THIRD slice must be rejected (bankroll fully in play)
    const c = await makePlayer();
    await c.buyIn(5_000_000);
    await c.ensureRoundInited();
    await expect(c.sliceFromPot(SLICE)).rejects.toMatchObject({ code: "bankroll_full" });

    // each plays a round + settles + sweeps its till back
    const playAndSettle = async (p: ReturnType<typeof createChainRound>) => {
      await p.open("BTC", 1, 100, STAKE, 60, 200_000);
      await sleep(6000);
      const settled = await p.close();
      expect(["cashout", "cap", "liq", "time"]).toContain(settled.outcomeName);
      await p.commitAndUndelegate();
      await p.sweepTill();
    };
    await Promise.all([playAndSettle(a), playAndSettle(b)]);

    // conservation across the pot: master net change == -(sum of player net P&L)
    const aNet = Number(await a.readPlayerBalance(false)) - 5_000_000;
    const bNet = Number(await b.readPlayerBalance(false)) - 5_000_000;
    const masterEnd = Number((await houseBalanceAt(master)).balance.toString());
    expect(masterEnd - masterStart).toBe(-(aNet + bNet));
  }, 300_000);

  // --- multi-asset: the registry must be readable INSIDE the ER (Task 0b probe) ---
  // A fresh mint/house is delegated per test; the GLOBAL [b"feeds"] registry is NOT
  // delegated (it stays on L1). open() reads it in-rollup — if these pass, clone-on-read
  // works → Option A. (Run scripts/bootstrap-devnet.mjs once so the registry exists.)
  const mkEnv = async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await sendIxHttp(conn, program.methods.initHouse(new anchor.BN(0)).accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }), funder);
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await sendIxHttp(conn, program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }), funder);
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
    const playerAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey);
    await mintTo(conn, funder, mint, playerAta.address, funder.publicKey, 5_000_000);
    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });
    return { funder, conn, program, mint, player, chain };
  };

  it("opens an open-ended Highway round that a refreshed client can recognize", async () => {
    const { chain } = await mkEnv();
    await chain.buyIn(5_000_000);
    await chain.ensureRoundInited();
    await chain.sliceFromPot(maxPayoutBase(1_000_000));
    await chain.delegate();

    try {
      const opened = await chain.open("SOL", 1, 10, 1_000_000, HIGHWAY_DURATION_SENTINEL, 200_000);
      const snap = await chain.readRound(true);

      expect(opened.deadlineTs).toBeLessThan(0);
      expect(snap).not.toBeNull();
      expect(isHighwayRound(snap!)).toBe(true);
    } finally {
      const snap = await chain.readRound(true).catch(() => null);
      if (snap?.status === 1) await chain.close().catch(() => undefined);
      await chain.commitAndUndelegate().catch(() => undefined);
      await chain.sweepTill().catch(() => undefined);
    }
  }, 180_000);

  it("opens an ETH round (reads the registry in-rollup) and settles conserved", async () => {
    const { chain } = await mkEnv();
    await chain.buyIn(5_000_000);
    await chain.ensureRoundInited();
    await chain.sliceFromPot(maxPayoutBase(1_000_000));
    await chain.delegate();

    const opened = await chain.open("ETH", 1, 100, 1_000_000, 60, 200_000); // long, 100x, 1 USDC on ETH
    expect(opened.feed).toBe("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG"); // bound to the ETH feed
    expect(opened.entryHuman).toBeGreaterThan(500); // ETH in the hundreds–thousands, not BTC's tens of thousands
    expect(opened.entryHuman).toBeLessThan(20_000);
    expect(await chain.readRoundStatus(true)).toBe(1);

    await sleep(6000);
    const settled = await chain.close();
    expect(["cashout", "cap", "liq", "time"]).toContain(settled.outcomeName);
    expect(settled.balance).toBe(5_000_000n - 1_000_000n + settled.payout); // conservation

    await chain.commitAndUndelegate();
    expect(await chain.readRoundStatus(false)).toBe(2);
  }, 180_000);

  it("opens a SOL round and the native crank settles it on the SOL feed (zero client tx)", async () => {
    const { chain } = await mkEnv();
    await chain.buyIn(5_000_000);
    await chain.ensureRoundInited();
    await chain.sliceFromPot(maxPayoutBase(1_000_000));
    await chain.delegate();

    const opened = await chain.open("SOL", 1, 2000, 1_000_000, 60, 200_000); // long, 2000x on SOL
    expect(opened.feed).toBe("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"); // bound to SOL
    expect(opened.entryHuman).toBeGreaterThan(10); // SOL in the tens, not BTC/ETH
    expect(opened.entryHuman).toBeLessThan(2_000);
    await chain.scheduleCrank({ intervalMs: 1000, iterations: 70 });

    // STOP touching it — the crank must drive it to status 2 reading the SOL feed alone.
    const deadline = Date.now() + 90_000;
    let snap = await chain.readRound(true);
    while (Date.now() < deadline && (!snap || snap.status !== 2)) {
      await sleep(2000);
      snap = await chain.readRound(true);
    }
    expect(snap?.status).toBe(2); // settled by the crank
    expect([1, 2, 3]).toContain(snap!.outcome); // cap | liq | time — never cashout (no client close)

    await chain.commitAndUndelegate();
    const l1 = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(l1));
    expect(await chain.readPlayerBalance(false)).toBe(0n);
  }, 240_000);

  it("rejects opening an ETH round against the BTC feed (registry binds the asset)", async () => {
    const { mint, player, chain } = await mkEnv();
    await chain.buyIn(5_000_000);
    await chain.ensureRoundInited();
    await chain.sliceFromPot(maxPayoutBase(1_000_000));
    await chain.delegate();

    // Build a direct ER open(asset=1 ETH) but pass the BTC feed — the registry requires
    // price_update == feeds[asset].feed, so this must be rejected (UntrustedFeed/2012).
    const erConn = new Connection(CHAIN.ER_RPC, { commitment: "confirmed" });
    const erProvider = new anchor.AnchorProvider(erConn, new anchor.Wallet(player), { commitment: "confirmed" });
    const erProgram = new anchor.Program(idl as anchor.Idl, erProvider);
    const pdas = deriveRaiderPdas(CHAIN.PROGRAM_ID, player.publicKey, mint);
    const registry = deriveFeedRegistry(CHAIN.PROGRAM_ID);
    const tx = await erProgram.methods.open(1, 1, 100, new anchor.BN(1_000_000), new anchor.BN(60), 200_000, 0, 0, 0, 0).accountsPartial({
      player: pdas.player, house: pdas.till, round: pdas.round, mint,
      priceUpdate: CHAIN.FEEDS.BTC, registry, playerAuthority: player.publicKey, // BTC feed on an ETH (asset 1) round
    }).transaction();
    tx.feePayer = player.publicKey;
    tx.recentBlockhash = (await erConn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(player);
    const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    let err: unknown = null;
    for (let i = 0; i < 30; i++) {
      const st = (await erConn.getSignatureStatuses([sig])).value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) { err = st.err; break; }
      await sleep(1000);
    }
    expect(err).not.toBeNull(); // the mismatched feed was rejected on-chain
    expect(await chain.readRoundStatus(true)).not.toBe(1); // no round opened

    await chain.commitAndUndelegate(); // free the shared house
  }, 180_000);

  // --- SOL stakes via wSOL: the stake mint is wrapped SOL; the client wraps native SOL on
  // buy-in and unwraps (closes the ATA) on withdraw. Uses the bootstrapped wSOL house. ---
  it("plays a full SOL (wSOL) round and unwraps back to native SOL, conserved", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });

    const mint = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL house (bootstrapped)
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.4 * LAMPORTS_PER_SOL })));
    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });

    await chain.wrapForBuyIn(100_000_000); // wrap 0.1 SOL → wSOL
    await chain.buyIn(100_000_000);
    expect(await chain.readPlayerBalance()).toBe(100_000_000n);
    await chain.ensureRoundInited();
    await chain.sliceFromPot(maxPayoutBase(50_000_000));
    await chain.delegate();
    await chain.open("SOL", 1, 50, 50_000_000, 60, 200_000); // 0.05 SOL stake on the SOL feed
    expect(await chain.readRoundStatus(true)).toBe(1);
    await sleep(6000);
    const settled = await chain.close();
    expect(settled.balance).toBe(100_000_000n - 50_000_000n + settled.payout); // conserved (lamports)
    await chain.commitAndUndelegate();
    const l1 = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(l1));
    await chain.unwrapAll();
    expect(await chain.readPlayerBalance(false)).toBe(0n);
  }, 180_000);
});
