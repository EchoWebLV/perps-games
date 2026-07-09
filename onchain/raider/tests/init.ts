// Task 4 driver: create a 6-decimal SPL test mint, call init_house, and assert
// the HouseBalance ledger PDA + the program-owned vault ATA both exist on devnet.
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair } = require("@solana/web3.js");
const {
  createMint,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/raider.json");

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";

describe("raider init_house", function () {
  this.timeout(1_000_000);

  const wallet = anchor.Wallet.local(); // ANCHOR_WALLET
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" }),
    wallet,
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, provider);

  let mint; // fresh 6-decimal mint per run
  let housePda, vaultAuthority, vaultToken;

  before(async () => {
    console.log("base  :", BASE_RPC);
    console.log("wallet:", wallet.publicKey.toBase58());
    // Create a fresh 6-decimal SPL mint (authority = our wallet).
    mint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      null,
      6
    );
    console.log("mint  :", mint.toBase58());

    [housePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("house2"), mint.toBuffer()],
      program.programId
    );
    [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer()],
      program.programId
    );
    vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    console.log("house :", housePda.toBase58());
    console.log("vaultA:", vaultAuthority.toBase58());
    console.log("vaultT:", vaultToken.toBase58());
  });

  it("init_house creates the HouseBalance PDA (balance=0, locked=0) and the vault ATA", async () => {
    await program.methods
      .initHouse(new anchor.BN(0))
      .accounts({
        authority: wallet.publicKey,
        mint,
        house: housePda,
        vaultAuthority,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ skipPreflight: true });

    const house = await program.account.houseBalance.fetch(housePda);
    assert.equal(house.authority.toBase58(), wallet.publicKey.toBase58());
    assert.equal(house.mint.toBase58(), mint.toBase58());
    assert.equal(house.balance.toNumber(), 0, "house.balance must start at 0");
    assert.equal(house.locked.toNumber(), 0, "house.locked must start at 0");

    const vaultInfo = await provider.connection.getAccountInfo(vaultToken);
    assert.ok(vaultInfo, "vault ATA must exist");
    assert.equal(
      vaultInfo.owner.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      "vault ATA must be owned by the token program"
    );
    console.log("init_house OK; house+vault created");

    // Stash the mint for the deposit/delegate suites (so they can reuse a house).
    require("fs").writeFileSync(
      "/tmp/raider-test-mint.json",
      JSON.stringify({ mint: mint.toBase58() })
    );
  });
});
