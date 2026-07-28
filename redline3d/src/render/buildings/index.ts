import type { BuiltBuilding, Track } from "./types";
import type { BuildingKind } from "../../core/lobby-layout";
import { buildGarage } from "./garage";
import { buildTrack } from "./track";
import { buildUpgrades } from "./upgrades";
import { buildCrates } from "./crates";
import { buildScrapyard } from "./scrapyard";
import { buildHighway } from "./highway";

export type { BuiltBuilding, Track } from "./types";

/** Dispatch to the themed builder for a lobby building. Each builds in local space with its
 *  front (entrance) on +Z; the lobby positions + rotates the returned group so +Z faces the plaza. */
export function buildBuilding(kind: BuildingKind, color: number, track: Track): BuiltBuilding {
  switch (kind) {
    case "garage": return buildGarage(color, track);
    case "track": return buildTrack(color, track);
    case "race": return buildTrack(color, track); // same start-light gantry — the sign + hot-pink neon tell the two race venues apart
    case "upgrades": return buildUpgrades(color, track);
    case "crates": return buildCrates(color, track);
    case "scrapyard": return buildScrapyard(color, track);
    case "highway": return buildHighway(color, track); // freeway overpass — its own look, not the track gantry
  }
}
