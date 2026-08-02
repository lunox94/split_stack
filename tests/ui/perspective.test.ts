import { describe, expect, it } from "vitest";

import { projectPerspective } from "../../src/app/perspective";

describe("projectPerspective", () => {
  it("puts a seated viewer on the left even when they occupy seat B", () => {
    expect(
      projectPerspective({
        viewerId: "player-b",
        seatAPlayerId: "player-a",
        seatBPlayerId: "player-b",
      }),
    ).toEqual({
      leftPlayerId: "player-b",
      rightPlayerId: "player-a",
      viewerRole: "seat-b",
      isSpectator: false,
    });
  });

  it("keeps seat A on the left for its own viewer", () => {
    expect(
      projectPerspective({
        viewerId: "player-a",
        seatAPlayerId: "player-a",
        seatBPlayerId: "player-b",
      }),
    ).toEqual({
      leftPlayerId: "player-a",
      rightPlayerId: "player-b",
      viewerRole: "seat-a",
      isSpectator: false,
    });
  });

  it("shows seat A left and seat B right to spectators", () => {
    expect(
      projectPerspective({
        viewerId: "spectator",
        seatAPlayerId: "player-a",
        seatBPlayerId: "player-b",
      }),
    ).toEqual({
      leftPlayerId: "player-a",
      rightPlayerId: "player-b",
      viewerRole: "spectator",
      isSpectator: true,
    });
  });
});
