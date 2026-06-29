import { describe, it, expect } from "vitest";
import { CHAIN } from "./config";

describe("CHAIN config", () => {
  it("pins the deployed program, feed, validator and endpoints", () => {
    expect(CHAIN.PROGRAM_ID.toBase58()).toBe("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");
    expect(CHAIN.BTC_FEED.toBase58()).toBe("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
    expect(CHAIN.VALIDATOR.toBase58()).toBe("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
    expect(CHAIN.DELEGATION_PROGRAM.toBase58()).toBe("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
    expect(CHAIN.ER_RPC).toBe("https://devnet.magicblock.app");
    expect(CHAIN.STAKE_MINT).toBe("So11111111111111111111111111111111111111112");
    expect(CHAIN.STAKE_DECIMALS).toBe(9);
  });

  it("pins the MagicBlock task-scheduler program id", () => {
    expect(CHAIN.MAGIC_PROGRAM.toBase58()).toBe("Magic11111111111111111111111111111111111111");
  });
});
