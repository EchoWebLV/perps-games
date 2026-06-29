import { describe, it, expect } from "vitest";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import idl from "./idl/raider.json";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import { createChainRound, deriveRaiderPdas } from "./chain-round";
import { CHAIN, deriveFeedRegistry } from "./config";

const RUN = process.env.RAIDER_DEVNET === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse().accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
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
    await chain.delegate();

    const opened = await chain.open("BTC", 1, 100, 1_000_000); // long, 100x, 1 USDC
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
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse().accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
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
    await chain.delegate();

    // open 2000x, exercise the mid-round actions, then arm the crank
    await chain.open("BTC", 1, 2000, 1_000_000);
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

  it("delegate() reuses our own live session and rejects a foreign wallet on the shared house", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // fresh mint + funded house shared by both players
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse().accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });

    // two independent dev-keypair players on the same mint
    const mkPlayer = async () => {
      const kp = Keypair.generate();
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
      const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mint, kp.publicKey);
      await mintTo(conn, funder, mint, ata.address, funder.publicKey, 5_000_000);
      const port = createDevKeypairPort({ secretKey: kp.secretKey, store: { get: () => null, set: () => {} } });
      await port.connect();
      return createChainRound({ wallet: portToAnchorWallet(port), mint });
    };
    const a = await mkPlayer();
    const b = await mkPlayer();

    // A takes the house
    await a.buyIn(5_000_000);
    await a.ensureRoundInited();
    await a.delegate();

    // A re-delegating is a clean reuse (no throw)
    await expect(a.delegate()).resolves.toBeUndefined();

    // B can't delegate against the held shared house — typed busy, not a raw revert
    await b.buyIn(5_000_000);
    await b.ensureRoundInited();
    await expect(b.delegate()).rejects.toMatchObject({ code: "delegate_busy" });

    // cleanup: A brings the house home so the shared PDA is free for the next run
    await a.commitAndUndelegate();
  }, 240_000);

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
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse().accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
    const playerAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey);
    await mintTo(conn, funder, mint, playerAta.address, funder.publicKey, 5_000_000);
    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });
    return { funder, conn, program, mint, player, chain };
  };

  it("opens an ETH round (reads the registry in-rollup) and settles conserved", async () => {
    const { chain } = await mkEnv();
    await chain.buyIn(5_000_000);
    await chain.ensureRoundInited();
    await chain.delegate();

    const opened = await chain.open("ETH", 1, 100, 1_000_000); // long, 100x, 1 USDC on ETH
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
    await chain.delegate();

    const opened = await chain.open("SOL", 1, 2000, 1_000_000); // long, 2000x on SOL
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
    await chain.delegate();

    // Build a direct ER open(asset=1 ETH) but pass the BTC feed — the registry requires
    // price_update == feeds[asset].feed, so this must be rejected (UntrustedFeed/2012).
    const erConn = new Connection(CHAIN.ER_RPC, { commitment: "confirmed" });
    const erProvider = new anchor.AnchorProvider(erConn, new anchor.Wallet(player), { commitment: "confirmed" });
    const erProgram = new anchor.Program(idl as anchor.Idl, erProvider);
    const pdas = deriveRaiderPdas(CHAIN.PROGRAM_ID, player.publicKey, mint);
    const registry = deriveFeedRegistry(CHAIN.PROGRAM_ID);
    const tx = await erProgram.methods.open(1, 1, 100, new anchor.BN(1_000_000)).accountsPartial({
      player: pdas.player, house: pdas.house, round: pdas.round, mint,
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
});
