import type { BuiltBuilding, Track } from "./types";
import type { BuildingKind } from "../../core/lobby-layout";
import { buildGarage } from "./garage";
import { buildTrack } from "./track";
import { buildUpgrades } from "./upgrades";
import { buildCrates } from "./crates";

export type { BuiltBuilding, Track } from "./types";

/** Dispatch to the themed builder for a lobby building. Each builds in local space with its
 *  front (entrance) on +Z; the lobby positions + rotates the returned group so +Z faces the plaza. */
export function buildBuilding(kind: BuildingKind, color: number, track: Track): BuiltBuilding {
  switch (kind) {
    case "garage": return buildGarage(color, track);
    case "track": return buildTrack(color, track);
    case "upgrades": return buildUpgrades(color, track);
    case "crates": return buildCrates(color, track);
  }
}
