import type { PlayerId } from "../domain/types";

export type ViewerRole = "seat-a" | "seat-b" | "spectator";

export interface PerspectiveRequest {
  readonly viewerId: PlayerId;
  readonly seatAPlayerId: PlayerId | null;
  readonly seatBPlayerId: PlayerId | null;
}

export interface BoardPerspective {
  readonly leftPlayerId: PlayerId | null;
  readonly rightPlayerId: PlayerId | null;
  readonly viewerRole: ViewerRole;
  readonly isSpectator: boolean;
}

export function projectPerspective({
  viewerId,
  seatAPlayerId,
  seatBPlayerId,
}: PerspectiveRequest): BoardPerspective {
  if (viewerId === seatBPlayerId) {
    return {
      leftPlayerId: seatBPlayerId,
      rightPlayerId: seatAPlayerId,
      viewerRole: "seat-b",
      isSpectator: false,
    };
  }

  return {
    leftPlayerId: seatAPlayerId,
    rightPlayerId: seatBPlayerId,
    viewerRole: viewerId === seatAPlayerId ? "seat-a" : "spectator",
    isSpectator: viewerId !== seatAPlayerId,
  };
}
