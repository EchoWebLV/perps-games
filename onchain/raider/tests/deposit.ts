// Task 5 driver: prove buy_in moves REAL USDC owner -> vault and credits the
// play balance, that the owner can withdraw it back, and — the load-bearing
// non-custodial invariant — that a DIFFERENT keypair cannot withdraw the
// victim's funds.
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/raider.json");
const { BN } = anchor;

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("raider buy_in + withdraw (non-custodial invariant)", function () {
  this.timeout(1_000_000);

  const wallet = anchor.Wallet.local(); // ANCHOR_WALLET = victim/owner
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }),
    wallet,
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, provider);

  let mint, housePda, vaultAuthority, vaultToken;
  let ownerToken, playerPda;

  const DEPOSIT = new BN(10_000_000); // 10 USDC (6 decimals)
  const WITHDRAW = new BN(4_000_000); // 4 USDC

  before(async () => {
    console.log("base  :", BASE_RPC);
    console.log("owner :", wallet.publicKey.toBase58());

    mint = await createMint(provider.connection, wallet.payer, wallet.publicKey, null, 6);
    [housePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("house2"), mint.toBuffer()], program.programId);
    [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()], program.programId);
    vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    [playerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player"), wallet.publicKey.toBuffer(), mint.toBuffer()], program.programId);

    // init house (creates the vault ATA) + an owner ATA funded with 10 USDC.
    await program.methods.initHouse(new anchor.BN(0)).accounts({
      authority: wallet.publicKey, mint, house: housePda, vaultAuthority, vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    const ownerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, wallet.payer, mint, wallet.publicKey);
    ownerToken = ownerAta.address;
    await mintTo(provider.connection, wallet.payer, mint, ownerToken, wallet.publicKey, 10_000_000);
    console.log("mint  :", mint.toBase58());
    console.log("player:", playerPda.toBase58());
    console.log("vaultT:", vaultToken.toBase58(), "ownerT:", ownerToken.toBase58());
  });

  it("buy_in credits player balance and moves real USDC to the vault", async () => {
    await program.methods.buyIn(DEPOSIT).accounts({
      owner: wallet.publicKey, mint, player: playerPda,
      ownerToken, vaultAuthority, vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    const player = await program.account.playerBalance.fetch(playerPda);
    assert.equal(player.balance.toString(), DEPOSIT.toString(), "play balance credited");
    assert.equal(player.owner.toBase58(), wallet.publicKey.toBase58());

    const vault = await getAccount(provider.connection, vaultToken);
    assert.equal(vault.amount.toString(), DEPOSIT.toString(), "real USDC sits in the vault");
    console.log("buy_in OK: player.balance=10e6, vault=10e6");
  });

  it("owner can withdraw their balance back to their ATA", async () => {
    const ownerBefore = (await getAccount(provider.connection, ownerToken)).amount;
    await program.methods.withdraw(WITHDRAW).accounts({
      owner: wallet.publicKey, mint, player: playerPda,
      vaultAuthority, vaultToken, ownerToken, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc({ skipPreflight: true });

    const player = await program.account.playerBalance.fetch(playerPda);
    assert.equal(player.balance.toString(), "6000000", "play balance now 6 USDC");
    const ownerAfter = (await getAccount(provider.connection, ownerToken)).amount;
    assert.equal((ownerAfter - ownerBefore).toString(), WITHDRAW.toString(),
      "owner ATA up by 4 USDC");
    const vault = await getAccount(provider.connection, vaultToken);
    assert.equal(vault.amount.toString(), "6000000", "vault down to 6 USDC");
    console.log("withdraw OK: player 6e6, owner +4e6, vault 6e6");
  });

  it("a NON-OWNER cannot withdraw the victim's funds (non-custodial invariant)", async () => {
    // Attacker = a fresh keypair, funded for fees from OUR wallet (faucet is
    // rate-limited on devnet — never rely on airdrop, or a fee/SOL failure would
    // mask the real constraint rejection we are trying to prove).
    const attacker = Keypair.generate();
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey, toPubkey: attacker.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      }));
    await provider.sendAndConfirm(fundTx);
    const attackerBal = await provider.connection.getBalance(attacker.publicKey);
    assert.ok(attackerBal >= 0.04 * LAMPORTS_PER_SOL,
      `attacker must be funded for fees so the rejection is the constraint, not lack of SOL (has ${attackerBal})`);

    // Attacker's own ATA (where stolen funds would land).
    const attackerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, wallet.payer, mint, attacker.publicKey);

    // Attacker provider/program so the attacker is the fee-payer + signer.
    const attackerWallet = new anchor.Wallet(attacker);
    const attackerProvider = new anchor.AnchorProvider(
      provider.connection, attackerWallet, { commitment: "confirmed" });
    const programAsAttacker = new anchor.Program(idl, attackerProvider);

    // Attacker signs as `owner` but points `player` at the VICTIM's player PDA.
    let rejected = false;
    let errMsg = "";
    try {
      // Preflight ON so the Anchor constraint error surfaces with its code/logs
      // (skipPreflight would return an opaque processed-tx error instead).
      await programAsAttacker.methods.withdraw(new BN(1_000_000)).accounts({
        owner: attacker.publicKey, // attacker is the signer
        mint,
        player: playerPda, // ...but targets the victim's PDA
        vaultAuthority, vaultToken, ownerToken: attackerAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([attacker]).rpc();
    } catch (e) {
      rejected = true;
      errMsg = (e && e.toString()) || "";
    }
    assert.ok(rejected, "non-owner withdraw MUST be rejected");
    // The rejection must be a REAL constraint failure, not an incidental one
    // (no fee SOL / missing account). The attacker signs as `owner`, so Anchor
    // re-derives player = [b"player", ATTACKER, mint] which != the victim PDA
    // address passed in => ConstraintSeeds (anchor code 2006 / "seeds constraint").
    const isConstraintReject =
      /ConstraintSeeds|seeds constraint|2006|ConstraintHasOne|has one constraint|2001|A seeds constraint/i.test(errMsg);
    assert.ok(isConstraintReject,
      "rejection must be the seeds/has_one constraint, not an incidental failure. got:\n" + errMsg);
    console.log("non-owner withdraw REJECTED by the seeds/has_one constraint as required. error:\n  " +
      errMsg.split("\n").slice(0, 5).join("\n  "));

    // And the victim's funds are untouched.
    const player = await program.account.playerBalance.fetch(playerPda);
    assert.equal(player.balance.toString(), "6000000", "victim balance untouched");
    const vault = await getAccount(provider.connection, vaultToken);
    assert.equal(vault.amount.toString(), "6000000", "vault untouched");
  });
});
