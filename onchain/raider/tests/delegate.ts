// Task 6 driver: buy_in, init_round, then co-delegate Player + House + Round to
// the MagicBlock ER in ONE instruction. Assert all three PDAs' owner flips to the
// delegation program. This is the player<->house value-movement topology the
// open/close loop (Tasks 7-8) runs on.
//
// Uses a FRESH session owner keypair (funded from ANCHOR_WALLET) so all three
// PDAs are brand-new and program-owned every run. The Round PDA seeds are
// [b"round", owner] (per plan — NOT mint-scoped), so reusing the base wallet
// would collide with a still-delegated round from a prior run; a fresh owner
// sidesteps that and also models the real "each player = own wallet" topology.
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/raider.json");
const { BN } = anchor;
const { deriveTill, maxPayout } = require("./helpers");

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const VALIDATOR = new PublicKey(process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const STAKE = 1_000_000; // 1 USDC — the slice is sized to the eventual open stake
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("raider delegate_session (co-delegate player+house+round)", function () {
  this.timeout(1_000_000);

  const funder = anchor.Wallet.local(); // ANCHOR_WALLET pays fees + rent
  const session = Keypair.generate(); // fresh per-run owner
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }),
    new anchor.Wallet(session),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, provider);

  let mint, housePda, till, vaultAuthority, vaultToken, playerPda, roundPda, ownerToken;

  before(async () => {
    console.log("base   :", BASE_RPC);
    console.log("funder :", funder.publicKey.toBase58());
    console.log("session:", session.publicKey.toBase58());
    console.log("valid  :", VALIDATOR.toBase58());

    // Fund the fresh session owner from the funder for rent + fees.
    const baseProvider = new anchor.AnchorProvider(
      provider.connection, funder, { commitment: "confirmed" });
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey, toPubkey: session.publicKey,
        lamports: 0.2 * LAMPORTS_PER_SOL,
      }));
    await baseProvider.sendAndConfirm(fundTx);

    // Mint authority = funder (it has the SOL); session owner just plays.
    mint = await createMint(provider.connection, funder.payer, funder.publicKey, null, 6);
    [housePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("house"), mint.toBuffer()], program.programId);
    till = deriveTill(program.programId, mint, session.publicKey); // per-session till (was the shared house)
    [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()], program.programId);
    vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    [playerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()], program.programId);
    [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), session.publicKey.toBuffer()], program.programId);

    // House (funder pays) + a session-owner ATA funded with 5 USDC + buy_in.
    await program.methods.initHouse().accounts({
      authority: funder.publicKey, mint, house: housePda, vaultAuthority, vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).signers([funder.payer]).rpc({ skipPreflight: true });

    // Fund the master pot so slice_from_pot can carve this session's till off it.
    const HOUSE_FUND = 30_000_000; // 30 USDC, headroom over one round's 23.75 slice
    const funderAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, funder.payer, mint, funder.publicKey);
    await mintTo(provider.connection, funder.payer, mint, funderAta.address, funder.publicKey, HOUSE_FUND);
    await program.methods.fundHouse(new BN(HOUSE_FUND)).accounts({
      funder: funder.publicKey, mint, house: housePda, funderToken: funderAta.address,
      vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([funder.payer]).rpc({ skipPreflight: true });

    const ownerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, funder.payer, mint, session.publicKey);
    ownerToken = ownerAta.address;
    await mintTo(provider.connection, funder.payer, mint, ownerToken, funder.publicKey, 5_000_000);

    await program.methods.buyIn(new BN(5_000_000)).accounts({
      owner: session.publicKey, mint, player: playerPda, ownerToken, vaultAuthority, vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    console.log("mint  :", mint.toBase58());
    console.log("player:", playerPda.toBase58());
    console.log("house :", housePda.toBase58());
    console.log("round :", roundPda.toBase58());
  });

  it("init_round creates the Round PDA in the idle state", async () => {
    await program.methods.initRound().accounts({
      owner: session.publicKey, round: roundPda, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });
    const round = await program.account.round.fetch(roundPda);
    assert.equal(round.owner.toBase58(), session.publicKey.toBase58());
    assert.equal(round.status, 0, "round must start idle");
    console.log("init_round OK: status=0");
  });

  it("delegate_session flips all three PDAs' owner to the delegation program", async () => {
    const PROG = program.programId.toBase58();

    // Carve a bet-sized till off the master pot BEFORE delegating it (the till, not
    // the master `[house, mint]`, is what co-delegates with player+round).
    await program.methods.sliceFromPot(new BN(maxPayout(STAKE))).accounts({
      owner: session.publicKey, mint, master: housePda, till, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    // pre-condition: all three fresh + program-owned
    for (const [name, pda] of [["player", playerPda], ["house", till], ["round", roundPda]]) {
      const o = (await provider.connection.getAccountInfo(pda)).owner.toBase58();
      assert.equal(o, PROG, `${name} should start program-owned`);
    }

    await program.methods.delegateSession().accounts({
      payer: session.publicKey, mint, player: playerPda, house: till, round: roundPda,
    }).remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }])
      .rpc({ skipPreflight: true });

    // poll until ALL THREE owners flip to the delegation program (~20s budget)
    const targets = { player: playerPda, house: till, round: roundPda };
    let flipped = {};
    for (let i = 0; i < 20; i++) {
      flipped = {};
      for (const [name, pda] of Object.entries(targets)) {
        const o = (await provider.connection.getAccountInfo(pda)).owner.toBase58();
        flipped[name] = o === DELEGATION_PROGRAM.toBase58();
      }
      if (flipped.player && flipped.house && flipped.round) {
        console.log(`all three delegated after ~${(i + 1) * 1000}ms`);
        break;
      }
      await sleep(1000);
    }
    assert.ok(flipped.player, "player did not delegate");
    assert.ok(flipped.house, "house did not delegate");
    assert.ok(flipped.round, "round did not delegate");
  });
});
