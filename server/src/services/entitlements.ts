import { perkEnvelope, carPerk, type PerkEnvelope } from "@perps/engine";
import type { Inventory } from "./inventory.js";
import type { Upgrades } from "./upgrades.js";
export function makeEntitlements(deps: { inventory: Inventory; upgrades: Upgrades }) {
  return {
    /** The perk envelope the player is entitled to with `carId`. Throws car_not_owned if they don't
     *  hold it. The authority Phase 2's /authorize validates the requested open params against. */
    async entitlementsFor(userId: string, carId: string): Promise<PerkEnvelope> {
      if (!(await deps.inventory.owns(userId, carId))) throw new Error("car_not_owned");
      const levels = await deps.upgrades.get(userId);
      return perkEnvelope(levels, carPerk(carId));
    },
  };
}
export type Entitlements = ReturnType<typeof makeEntitlements>;
