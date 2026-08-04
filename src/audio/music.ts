export type MusicTrackId =
  | "bloody-tears"
  | "mountain-king"
  | "bumblebee"
  | "popcorn";

// Tracker modules have their own fixed arrangements. The game still exposes
// intensity so callers do not need to couple gameplay state to the player.
export type MusicIntensity = "calm" | "building" | "danger";

export interface ModuleTrack {
  readonly id: MusicTrackId;
  readonly title: string;
  readonly fileName: string;
  readonly assetUrl: string;
  readonly credit: string;
  readonly modArchiveId: number;
  readonly sourceUrl: string;
  readonly sha256: string;
}

function moduleTrack(
  track: Omit<ModuleTrack, "assetUrl" | "sourceUrl">,
): ModuleTrack {
  return {
    ...track,
    assetUrl: `./music/${track.fileName}`,
    sourceUrl:
      `https://modarchive.org/index.php?request=view_by_moduleid&query=${track.modArchiveId}`,
  };
}

export const MODULE_TRACKS: readonly ModuleTrack[] = [
  moduleTrack({
    id: "bloody-tears",
    title: "Bloody Tears",
    fileName: "bloody_tears.mod",
    credit:
      "X68000 conversion by Estrayk (Capsule / Scoopex), June 2023, for Dante.",
    modArchiveId: 212035,
    sha256: "76e82333f8c6e17707f41c4c82ca36928d6b94dd0c6b8dfdae0c148150303414",
  }),
  moduleTrack({
    id: "mountain-king",
    title: "In the Hall of the Mountain King",
    fileName: "radix-mountain_king.mod",
    credit: "Module by Radix / Limited Edition.",
    modArchiveId: 67602,
    sha256: "3605bb8d15ab070fe5c89f1a2020b6f4b1c922db2862d1ce66f0ecb2f115ca3d",
  }),
  moduleTrack({
    id: "bumblebee",
    title: "Flight of the Bumblebee",
    fileName: "flight_of_bumble_bee.mod",
    credit: "Module edited by Frog & Max Schorwer.",
    modArchiveId: 97600,
    sha256: "7ae9abff166887906f4ac76635ffca186139d1bb1abfdab463a117126990af5c",
  }),
  moduleTrack({
    id: "popcorn",
    title: "Popcorn",
    fileName: "galaxy_-_popcorn.mod",
    credit: "Arranger not identified in the module or Mod Archive listing.",
    modArchiveId: 187118,
    sha256: "bc756fc62d403ee7837695d4933cc8e2b56de49666b37b8560fb8dabbc7a1aab",
  }),
];

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function selectTrackForMatch(
  matchSeed: string,
  rematchIndex: number,
): ModuleTrack {
  const offset = Math.max(0, Math.floor(rematchIndex));
  const index = (stableHash(matchSeed) + offset) % MODULE_TRACKS.length;
  return MODULE_TRACKS[index] as ModuleTrack;
}
