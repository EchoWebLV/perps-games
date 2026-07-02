import fs from "node:fs";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
const idl = JSON.parse(fs.readFileSync(new URL("./src/chain/idl/raider.json", import.meta.url)));
const env = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
const kp = Keypair.fromSecretKey(Buffer.from(/VITE_DEV_SECRET=([^\n]+)/.exec(env)[1].trim(), "base64"));
const cfg = fs.readFileSync(new URL("./src/chain/config.ts", import.meta.url), "utf8");
const mint = new PublicKey(/MINT[^"]*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(cfg)[1]);
const pid = new PublicKey(idl.address);
const owner = kp.publicKey;
const seeds = {
  round: [Buffer.from("round"), owner.toBuffer()],
  player: [Buffer.from("player"), owner.toBuffer(), mint.toBuffer()],
  house: [Buffer.from("house2"), mint.toBuffer()],
  till: [Buffer.from("house2"), mint.toBuffer(), owner.toBuffer()],
};
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const DELEG = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
for (const [name, s] of Object.entries(seeds)) {
  const [pda] = PublicKey.findProgramAddressSync(s, pid);
  const info = await conn.getAccountInfo(pda);
  if (!info) { console.log(name, pda.toBase58(), "→ MISSING"); continue; }
  const own = info.owner.toBase58();
  let bal = "";
  if (own === pid.toBase58() || own === DELEG) {
    // vault-style accounts: u64 balance after discriminator+pubkeys — just show data len + first bytes
    bal = " len=" + info.data.length;
  }
  console.log(name, pda.toBase58(), "owner=", own === DELEG ? "DELEGATED" : own === pid.toBase58() ? "raider" : own, bal);
}
