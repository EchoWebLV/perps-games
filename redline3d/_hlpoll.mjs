// Poll the dev wallet's Round on the ER: print when OPEN (dur/lev stamped) and when SETTLED.
import fs from "node:fs";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { BorshAccountsCoder } = anchorPkg;
const idl = JSON.parse(fs.readFileSync(new URL("./src/chain/idl/raider.json", import.meta.url)));
const env = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
const kp = Keypair.fromSecretKey(Buffer.from(/VITE_DEV_SECRET=([^\n]+)/.exec(env)[1].trim(), "base64"));
const programId = new PublicKey(idl.address);
const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), kp.publicKey.toBuffer()], programId);
const coder = new BorshAccountsCoder(idl);
const er = new Connection("https://devnet.magicblock.app", "confirmed");
let openSeen = false;
const t0 = Date.now();
while (Date.now() - t0 < 220_000) {
  try {
    const info = await er.getAccountInfo(round);
    if (info) {
      const r = coder.decode("Round", info.data);
      const dur = Number(r.deadline_ts) - Number(r.entry_ts);
      if (r.status === 1 && !openSeen) {
        openSeen = true;
        console.log(`OPEN lev=${r.lev} stake=${r.stake} dur=${dur}s grace=${r.grace_secs} sl=${r.sl_fp} tp=${r.tp_fp} liq=${r.liq_fp} entryTs=${r.entry_ts}`);
      }
      if (r.status === 2 && openSeen) {
        console.log(`SETTLED outcome=${r.outcome} ranSecs=${Number(r.exit_ts) - Number(r.entry_ts)} payout=${r.payout} dur=${dur}s`);
        process.exit(0);
      }
    }
  } catch (e) { console.log("poll err:", String(e).slice(0, 80)); }
  await new Promise((res) => setTimeout(res, 5000));
}
console.log("TIMEOUT waiting for round; openSeen=" + openSeen);
process.exit(1);
