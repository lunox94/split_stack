import { describe, expect, it } from "vitest";
import { getKickTests, nextRotation } from "../../src/domain/srs";

describe("SRS rotation data", () => {
  it("wraps clockwise and counterclockwise rotation states", () => {
    expect([0, 1, 2, 3].map((rotation) => nextRotation(rotation as 0 | 1 | 2 | 3, "cw")))
      .toEqual([1, 2, 3, 0]);
    expect([0, 1, 2, 3].map((rotation) => nextRotation(rotation as 0 | 1 | 2 | 3, "ccw")))
      .toEqual([3, 0, 1, 2]);
  });

  it.each([
    [0, 1, [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]],
    [1, 0, [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]],
    [1, 2, [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]],
    [2, 1, [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]],
    [2, 3, [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]],
    [3, 2, [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]],
    [3, 0, [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]],
    [0, 3, [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]],
  ] as const)("exposes canonical JLSTZ kicks for %i→%i", (from, to, expected) => {
    expect(getKickTests("T", from, to).map(({ x, y }) => [x, y])).toEqual(expected);
  });

  it.each([
    [0, 1, [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]]],
    [1, 0, [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]]],
    [1, 2, [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]],
    [2, 1, [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]]],
    [2, 3, [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]]],
    [3, 2, [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]]],
    [3, 0, [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]]],
    [0, 3, [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]],
  ] as const)("exposes canonical I kicks for %i→%i", (from, to, expected) => {
    expect(getKickTests("I", from, to).map(({ x, y }) => [x, y])).toEqual(expected);
  });
});
