import { describe, it, expect } from "vitest";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import idl from "./idl/raider.json";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import { createChainRound, deriveRaiderPdas, maxPayoutBase } from "./chain-round";
import { CHAIN } from "./config";

const RUN = process.env.RAIDER_DEVNET === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SCALE = 1_000_000n;

/** Flintstone "Stone-Age Airbag": a liquidation pays min(refund_fp, wreck equity) through the
 *  standard payout path instead of 0. Proven here on a REAL crank-settled devnet liquidation:
 *  high leverage so the floor breach lands in seconds, then the settled payout is recomputed
 *  from the round's own stamped integers exactly the way settle.rs computes it. */
describe.skipIf(!RUN)("airbag liq refund (devnet)", () => {
  it("stamps refund_fp at open; a crank liquidation pays min(refund, wreck equity), conserved", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // operator: fresh mint + house funded over the 3000x pre-lock (23.75x per round)
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house2"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse(new anchor.BN(0)).accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 250_000_000);
    await program.methods.fundHouse(new anchor.BN(250_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });

    // player: throwaway keypair funded with SOL (fees) + tokens (stake)
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
    const playerAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey);
    await mintTo(conn, funder, mint, playerAta.address, funder.publicKey, 5_000_000);

    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });

    await chain.buyIn(5_000_000);
    await chain.ensureRoundInited();
    // 3x one round's max payout: a profitable time-settle must not strand the till below
    // the next attempt's lock (the same reason the game slices SESSION_TILL_ROUNDS x).
    await chain.sliceFromPot(maxPayoutBase(1_000_000) * 3);
    await chain.delegate();

    // 1000x with the max 20% airbag: a ~0.08% adverse move breaches the 0.20 floor and the
    // crank settles the liq with zero client tx. 1000x (not 3000x) keeps the floor band
    // 0.02% wide, so the breaching tick usually lands INSIDE it (nonzero wreck equity) —
    // at 3000x a single tick gapped 0.2->0 and the refund sample was the degenerate 0.
    // A calm-but-drifting market can still time-settle one direction, so alternate
    // long/short across up to 3 rounds.
    const STAKE = 1_000_000n;
    const erProvider = new anchor.AnchorProvider(new Connection(CHAIN.ER_RPC, { commitment: "confirmed" }), new anchor.Wallet(funder), { commitment: "confirmed" });
    const erProgram = new anchor.Program(idl as anchor.Idl, erProvider);
    const pdas = deriveRaiderPdas(program.programId, player.publicKey, mint);

    let snap = null as Awaited<ReturnType<typeof chain.readRound>>;
    let balBefore = 0n;
    let liqSeen = false;
    for (let attempt = 0; attempt < 3 && !liqSeen; attempt++) {
      const dir = (attempt % 2 === 0 ? 1 : -1) as 1 | -1;
      balBefore = await chain.readPlayerBalance(true);
      await chain.open("BTC", dir, 1000, Number(STAKE), 120, 200_000, 0, 0, 0, 200_000);
      if (attempt === 0) {
        // refund_fp really stamped on the ER round (provable fairness: the knob is on-chain state)
        const stamped = await (erProgram.account as any).round.fetch(pdas.round);
        expect(stamped.refundFp).toBe(200_000);
      }
      await chain.scheduleCrank({ iterations: 130, taskId: 7100 + attempt });
      for (let i = 0; i < 140; i++) {
        snap = await chain.readRound(true).catch(() => null);
        if (snap && snap.status === 2) break;
        await sleep(1000);
      }
      expect(snap?.status).toBe(2);
      if (snap!.outcomeName === "liq") liqSeen = true;
      // eslint-disable-next-line no-console
      else console.log(`attempt ${attempt} (${dir === 1 ? "long" : "short"}): ${snap!.outcomeName} — retrying opposite direction`);
    }
    if (!liqSeen) throw new Error("no liquidation in 3 alternating 1000x rounds — market absurdly flat, rerun");
    expect(snap!.outcomeName).toBe("liq");

    // Recompute the wreck equity from the round's own stamped integers, settle.rs-style,
    // and assert the payout is EXACTLY the airbag formula: payout(stake, min(refund, eq)).
    const ratio = (snap!.exitRaw * SCALE) / snap!.entryRaw;
    const seg = BigInt(snap!.dir) * BigInt(snap!.lev) * (ratio - SCALE);
    let eq = SCALE + snap!.banked + seg;
    if (eq < 0n) eq = 0n;
    const minEq = eq < 200_000n ? eq : 200_000n;
    const expected = (STAKE * minEq * 950_000n) / SCALE / SCALE;
    expect(snap!.payout).toBe(expected);
    expect(snap!.payout).toBeLessThanOrEqual(190_000n); // never more than 19% of stake (20% × 0.95 edge)

    // conservation on the ER ledger across the liq round: balance = before − stake + refund
    expect(await chain.readPlayerBalance(true)).toBe(balBefore - STAKE + snap!.payout);

    // eslint-disable-next-line no-console
    console.log(`AIRBAG PROOF: liq at eq=${Number(eq) / 1e6}x → payout ${snap!.payout} (${Number(snap!.payout) / 10_000}% of stake)`);

    await chain.commitAndUndelegate();
    expect(await chain.readRoundStatus(false)).toBe(2);
  }, 600_000);
});
