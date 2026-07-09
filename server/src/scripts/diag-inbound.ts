import { env } from "../env.js";
import { makeRpcDepositSource } from "../solana/deposit-source.js";

const SIG = "5eScs3shvgvvHVMrCWbWHubxzKkZgBt4nNYNVRjBP75weKTojjofstqPsj9UMRPto96K2DMaL2v7VvPc1byNADU8";

async function main() {
  const src = makeRpcDepositSource(env.SOLANA_RPC_URL!);
  const ata = env.TREASURY_USDC_ATA!;
  console.log("RPC:", env.SOLANA_RPC_URL!.replace(/(:\/\/[^/]+\/).*/, "$1[redacted]"));
  console.log("treasuryAta:", ata);

  try {
    const { transfers } = await src.fetchInbound({ treasuryAta: ata, limit: 50 });
    console.log("fetchInbound count:", transfers.length);
    const hit = transfers.find((t) => t.txSig === SIG);
    console.log("our $1 tx in fetchInbound?", !!hit);
    console.log("recent:", transfers.slice(0, 6).map((t) => `${t.txSig.slice(0, 8)}:${String(t.amountBaseUnits)}:${t.sourceOwner.slice(0, 6)}`));
  } catch (e: any) {
    console.log("fetchInbound ERROR:", e?.message || e);
  }

  if ((src as any).fetchTransfer) {
    try {
      const d = await (src as any).fetchTransfer({ treasuryAta: ata, txSig: SIG });
      console.log("fetchTransfer:", d ? { src: d.sourceOwner.slice(0, 10), units: String(d.amountBaseUnits) } : "NULL");
    } catch (e: any) {
      console.log("fetchTransfer ERROR:", e?.message || e);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
