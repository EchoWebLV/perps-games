// PDA derivation + a BigInt mirror of book.rs, so the e2e driver settles against
// the SAME definitions the program uses. Truncating BigInt division mirrors Rust
// u128 integer division exactly. Same shape as tests/helpers.ts.
const { PublicKey } = require("@solana/web3.js");

const SCALE = 1_000_000n;
const RAKE_FP = 50_000n;

// Mirror of book::settle_pool.
function settlePool(total, winnerPool) {
  const t = BigInt(total),
    w = BigInt(winnerPool);
  if (w === 0n) return { multFp: 0n, rake: t };
  const rake = (t * RAKE_FP) / SCALE;
  const payable = t - rake;
  return { multFp: (payable * SCALE) / w, rake };
}

// Mirror of book::payout_of.
const payoutOf = (stake, multFp) => (BigInt(stake) * BigInt(multFp)) / SCALE;

const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];

const deriveBook = (pid, mint) => pda([Buffer.from("book"), mint.toBuffer()], pid);
const deriveRace = (pid, mint) => pda([Buffer.from("race"), mint.toBuffer()], pid);
const deriveVault = (pid, mint) => pda([Buffer.from("vault"), mint.toBuffer()], pid);
const deriveBettor = (pid, owner, mint) =>
  pda([Buffer.from("bettor"), owner.toBuffer(), mint.toBuffer()], pid);
const deriveTicket = (pid, owner, mint) =>
  pda([Buffer.from("ticket"), owner.toBuffer(), mint.toBuffer()], pid);

module.exports = {
  SCALE,
  RAKE_FP,
  settlePool,
  payoutOf,
  deriveBook,
  deriveRace,
  deriveVault,
  deriveBettor,
  deriveTicket,
};
