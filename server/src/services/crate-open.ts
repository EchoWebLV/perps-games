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
  vrfBytes: string;
  solSignature?: string;
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
      const draws = bytesToDraws(hexToBytes(input.vrfBytes), 4);

      if (input.payment === "gift") {
        const claim = await usersApi.claimWelcome(userId);
        if (!claim.granted) throw new Error("welcome_already_claimed");
      } else if (input.payment === "coins") {
        const posted = await ledger.debit(userId, "coin", crate.priceCoins, "crate", `${userId}:crate:${input.vrfBytes}`);
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
      if (scrap > 0) await ledger.credit(userId, "scrap", scrap, "crate_scrap", `${userId}:crate_scrap:${input.vrfBytes}`);

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
