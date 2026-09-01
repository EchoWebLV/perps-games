import type { Ledger } from "./ledger.js";
import type { Inventory } from "./inventory.js";
import type { Users } from "./users.js";
import {
  CRATE_ROSTER, crateByKey, dupeScrap, hexToBytes, bytesToDraws,
  nextPity, rollCrateWithPity, type CrateKey,
} from "./crate-math.js";

export interface OpenInput {
  crateKey: CrateKey;
  payment: "coins" | "sol" | "gift";
  /** Solana rail (parked): 32-byte hex from MagicBlock VRF, expanded into draws here. */
  vrfBytes?: string;
  /**
   * EVM rail: draws already resolved server-side from a consumed commit-reveal (crate-roll). `ref`
   * is the spend's idempotency key — the commit id — and stands in for vrfBytes, which used to be
   * both the randomness AND the replay guard.
   */
  roll?: { draws: number[]; ref: string };
  solSignature?: string;
}

/**
 * Where the outcome's randomness comes from. Exactly one source is honoured per open: a consumed
 * commit (preferred) or raw VRF bytes. `ref` keys the ledger idempotency so the same randomness can
 * never be paid for twice.
 */
export function resolveRoll(input: OpenInput): { draws: number[]; ref: string } {
  if (input.roll) {
    if (input.roll.draws.length < 4) throw new Error("bad_draws");
    return input.roll;
  }
  if (!input.vrfBytes) throw new Error("bad_vrf_bytes");
  return { draws: bytesToDraws(hexToBytes(input.vrfBytes), 4), ref: input.vrfBytes };
}

function parsePity(raw: string | null | undefined): Record<CrateKey, number> {
  let src: Record<string, unknown> = {};
  try { src = JSON.parse(raw || "{}"); } catch { src = {}; }
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  return { wooden: n(src.wooden), silver: n(src.silver), gold: n(src.gold) };
}

export function makeCrateOpen(ledger: Ledger, inventory: Inventory, usersApi: Users) {
  return {
    async open(userId: string, input: OpenInput) {
      const crate = crateByKey(input.crateKey);
      if (crate.key !== input.crateKey) throw new Error("bad_crate");
      const { draws, ref } = resolveRoll(input);

      if (input.payment === "gift") {
        const claim = await usersApi.claimWelcome(userId);
        if (!claim.granted) throw new Error("welcome_already_claimed");
      } else if (input.payment === "coins") {
        const posted = await ledger.debit(userId, "coin", crate.priceCoins, "crate", `${userId}:crate:${ref}`);
        if (!posted) throw new Error("crate_replay");
      } else if (input.payment === "sol") {
        if (!input.solSignature || input.solSignature.length < 32) throw new Error("sol_signature_required");
      } else {
        throw new Error("bad_payment");
      }

      const pity = parsePity(await usersApi.cratePity(userId));
      const misses = pity[crate.key];
      const car = rollCrateWithPity(CRATE_ROSTER, crate.key, crate.tierWeights, misses, draws[0], draws[1]);
      if (!car) throw new Error("empty_pool");

      const granted = await inventory.grant(userId, car.name);
      let scrap = crate.scrap;
      if (!granted.isNew) scrap += dupeScrap(car.rarity);
      if (scrap > 0) await ledger.credit(userId, "scrap", scrap, "crate_scrap", `${userId}:crate_scrap:${ref}`);

      pity[crate.key] = nextPity(crate.key, misses, car.rarity);
      await usersApi.setCratePity(userId, JSON.stringify(pity));

      return {
        carId: car.name,
        isNew: granted.isNew,
        count: granted.count,
        scrap,
        scrapTotal: await ledger.balance(userId, "scrap"),
        coins: await ledger.balance(userId, "coin"),
        levelKey: null as string | null,
        pity,
      };
    },
  };
}

export type CrateOpen = ReturnType<typeof makeCrateOpen>;
