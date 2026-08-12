import { describe, expect, it } from "vitest";

import {
  MODULE_TRACKS,
  musicProgramForMatch,
  selectTrackForMatch,
} from "../../src/audio/music";

describe("tracker match music", () => {
  it("represents current playback as a one-track music program", () => {
    const program = musicProgramForMatch("shared-match-seed", 2);

    expect(program.tracks).toHaveLength(1);
    expect(program.tracks[0]).toBe(selectTrackForMatch("shared-match-seed", 2));
  });

  it("selects all four supplied modules deterministically before repeating", () => {
    const firstCycle = [0, 1, 2, 3].map(
      (rematch) => selectTrackForMatch("shared-match-seed", rematch).id,
    );

    expect(MODULE_TRACKS.map((track) => [track.id, track.title])).toEqual([
      ["bloody-tears", "Bloody Tears"],
      ["mountain-king", "In the Hall of the Mountain King"],
      ["bumblebee", "Flight of the Bumblebee"],
      ["popcorn", "Popcorn"],
    ]);
    expect(new Set(firstCycle).size).toBe(4);
    expect(selectTrackForMatch("shared-match-seed", 0).id).toBe(firstCycle[0]);
    expect(selectTrackForMatch("shared-match-seed", 4).id).toBe(firstCycle[0]);
  });

  it("calibrates rendered tracker loudness to the quietest bundled module", () => {
    // Fixed gains come from a full stereo 44.1kHz RMS render of each module.
    expect(MODULE_TRACKS.map((track) => [track.id, track.mixGain])).toEqual([
      ["bloody-tears", 1],
      ["mountain-king", 0.6774],
      ["bumblebee", 0.9363],
      ["popcorn", 0.7766],
    ]);
  });

  it("keeps provenance next to every module asset", () => {
    expect(
      MODULE_TRACKS.map(({ fileName, modArchiveId, sha256 }) => ({
        fileName,
        modArchiveId,
        sha256,
      })),
    ).toEqual([
      {
        fileName: "bloody_tears.mod",
        modArchiveId: 212035,
        sha256: "76e82333f8c6e17707f41c4c82ca36928d6b94dd0c6b8dfdae0c148150303414",
      },
      {
        fileName: "radix-mountain_king.mod",
        modArchiveId: 67602,
        sha256: "3605bb8d15ab070fe5c89f1a2020b6f4b1c922db2862d1ce66f0ecb2f115ca3d",
      },
      {
        fileName: "flight_of_bumble_bee.mod",
        modArchiveId: 97600,
        sha256: "7ae9abff166887906f4ac76635ffca186139d1bb1abfdab463a117126990af5c",
      },
      {
        fileName: "galaxy_-_popcorn.mod",
        modArchiveId: 187118,
        sha256: "bc756fc62d403ee7837695d4933cc8e2b56de49666b37b8560fb8dabbc7a1aab",
      },
    ]);
  });
});
