import type { Coordinate, Rotation, StandardShape } from "./types";

export type RotationDirection = "cw" | "ccw";

const JLSTZ_KICKS: Readonly<Record<string, readonly Coordinate[]>> = {
  "0>1": [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: 2 }, { x: -1, y: 2 }],
  "1>0": [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: -2 }, { x: 1, y: -2 }],
  "1>2": [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: -2 }, { x: 1, y: -2 }],
  "2>1": [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: 2 }, { x: -1, y: 2 }],
  "2>3": [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  "3>2": [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: -2 }, { x: -1, y: -2 }],
  "3>0": [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: -2 }, { x: -1, y: -2 }],
  "0>3": [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
};

const I_KICKS: Readonly<Record<string, readonly Coordinate[]>> = {
  "0>1": [{ x: 0, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 1 }, { x: 1, y: -2 }],
  "1>0": [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: -1, y: 0 }, { x: 2, y: -1 }, { x: -1, y: 2 }],
  "1>2": [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 2, y: 0 }, { x: -1, y: -2 }, { x: 2, y: 1 }],
  "2>1": [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 2 }, { x: -2, y: -1 }],
  "2>3": [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: -1, y: 0 }, { x: 2, y: -1 }, { x: -1, y: 2 }],
  "3>2": [{ x: 0, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 1 }, { x: 1, y: -2 }],
  "3>0": [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 2 }, { x: -2, y: -1 }],
  "0>3": [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 2, y: 0 }, { x: -1, y: -2 }, { x: 2, y: 1 }],
};

const OVERSIZE_KICKS = [
  { x: 0, y: 0 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -2, y: 0 },
  { x: 2, y: 0 },
  { x: 0, y: -1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
  { x: 0, y: -2 },
  { x: 0, y: 2 },
] as const satisfies readonly Coordinate[];

export function nextRotation(
  rotation: Rotation,
  direction: RotationDirection,
): Rotation {
  return ((rotation + (direction === "cw" ? 1 : 3)) % 4) as Rotation;
}

export function getKickTests(
  shape: StandardShape,
  from: Rotation,
  to: Rotation,
): readonly Coordinate[] {
  if (shape === "O" || from === to) return [{ x: 0, y: 0 }];
  const kicks = (shape === "I" ? I_KICKS : JLSTZ_KICKS)[`${from}>${to}`];
  if (kicks === undefined) {
    throw new RangeError(`SRS supports only quarter-turn transitions: ${from}>${to}`);
  }
  return kicks;
}

export function getOversizeKickTests(
  from: Rotation,
  to: Rotation,
): readonly Coordinate[] {
  if (from === to) return [{ x: 0, y: 0 }];
  if ((from + 1) % 4 !== to && (from + 3) % 4 !== to) {
    throw new RangeError(`Oversize kicks support only quarter turns: ${from}>${to}`);
  }
  return OVERSIZE_KICKS;
}
