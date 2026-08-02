import { describe, expect, it } from "vitest";
import {
  getPieceCells,
  getSpawnPosition,
  isHoldable,
} from "../../src/domain/pieces";
import { createBoard } from "../../src/domain/board";
import { canSpawn, collides, isGrounded } from "../../src/domain/collision";
import type { ActivePiece, PieceDescriptor, Rotation } from "../../src/domain/types";
import {
  getDropDistance,
  getGhostY,
  hardDrop,
  spawnPiece,
  tryGravityStep,
  tryMove,
  tryRotate,
} from "../../src/domain/movement";

function active(
  descriptor: PieceDescriptor,
  x: number,
  y: number,
  rotation: Rotation = 0,
): ActivePiece {
  return {
    descriptor,
    x,
    y,
    rotation,
    lockTicksRemaining: 30,
    lockResetCount: 0,
  };
}

describe("canonical piece geometry", () => {
  it("uses the canonical SRS spawn cells for every standard shape", () => {
    expect(
      (["I", "J", "L", "O", "S", "T", "Z"] as const).map((shape) => [
        shape as string,
        getPieceCells(shape, 0).map(({ x, y }) => [x, y]),
      ]),
    ).toEqual([
      ["I", [[0, 1], [1, 1], [2, 1], [3, 1]]],
      ["J", [[0, 0], [0, 1], [1, 1], [2, 1]]],
      ["L", [[2, 0], [0, 1], [1, 1], [2, 1]]],
      ["O", [[1, 0], [2, 0], [1, 1], [2, 1]]],
      ["S", [[1, 0], [2, 0], [0, 1], [1, 1]]],
      ["T", [[1, 0], [0, 1], [1, 1], [2, 1]]],
      ["Z", [[0, 0], [1, 0], [1, 1], [2, 1]]],
    ]);
  });

  it("rotates the T shape clockwise around its SRS pivot", () => {
    expect(getPieceCells("T", 1)).toEqual([
      { x: 2, y: 1, index: 0 },
      { x: 1, y: 0, index: 1 },
      { x: 1, y: 1, index: 2 },
      { x: 1, y: 2, index: 3 },
    ]);
  });

  it("keeps I-mino identities stable through all four SRS orientations", () => {
    expect(([0, 1, 2, 3] as const).map((rotation) => getPieceCells("I", rotation)))
      .toEqual([
        [
          { x: 0, y: 1, index: 0 }, { x: 1, y: 1, index: 1 },
          { x: 2, y: 1, index: 2 }, { x: 3, y: 1, index: 3 },
        ],
        [
          { x: 2, y: 0, index: 0 }, { x: 2, y: 1, index: 1 },
          { x: 2, y: 2, index: 2 }, { x: 2, y: 3, index: 3 },
        ],
        [
          { x: 3, y: 2, index: 0 }, { x: 2, y: 2, index: 1 },
          { x: 1, y: 2, index: 2 }, { x: 0, y: 2, index: 3 },
        ],
        [
          { x: 1, y: 3, index: 0 }, { x: 1, y: 2, index: 1 },
          { x: 1, y: 1, index: 2 }, { x: 1, y: 0, index: 3 },
        ],
      ]);
  });

  it("uses the configured disconnected Hollow Cross geometry", () => {
    expect(getPieceCells("cross", 0)).toEqual([
      { x: 2, y: 0, index: 0 },
      { x: 2, y: 1, index: 1 },
      { x: 0, y: 2, index: 2 },
      { x: 1, y: 2, index: 3 },
      { x: 3, y: 2, index: 4 },
      { x: 4, y: 2, index: 5 },
      { x: 2, y: 3, index: 6 },
      { x: 2, y: 4, index: 7 },
    ]);
  });

  it("models monomino and acid projectiles as one-cell shapes", () => {
    expect(getPieceCells("monomino", 3)).toEqual([{ x: 0, y: 0, index: 0 }]);
    expect(getPieceCells("acid", 2)).toEqual([{ x: 0, y: 0, index: 0 }]);
  });

  it("spawns each source at its deterministic lower-center alignment", () => {
    expect(getSpawnPosition({ source: "base", shape: "T" })).toEqual({ x: 3, y: 0 });
    expect(getSpawnPosition({ source: "cross", shape: "cross" })).toEqual({ x: 2, y: 0 });
    expect(getSpawnPosition({ source: "monomino", shape: "monomino" })).toEqual({ x: 4, y: 0 });
    expect(getSpawnPosition({ source: "acid", shape: "acid" })).toEqual({ x: 4, y: 0 });
  });

  it("allows Hold only for base-sequence tetrominoes", () => {
    expect(isHoldable({
      source: "base",
      shape: "T",
      specialCellIndex: 2,
      specialKind: "glitch-core",
    })).toBe(true);
    expect(isHoldable({ source: "glitch", shape: "T" })).toBe(false);
    expect(isHoldable({ source: "cross", shape: "cross" })).toBe(false);
    expect(isHoldable({ source: "monomino", shape: "monomino" })).toBe(false);
    expect(isHoldable({ source: "acid", shape: "acid" })).toBe(false);
  });
});

describe("piece collision", () => {
  it("rejects walls, floor, ceiling, and occupied settled cells", () => {
    const grid = createBoard();
    grid[1]![4] = { kind: "garbage" };

    expect(collides(grid, active({ source: "base", shape: "T" }, 3, 0))).toBe(true);
    expect(collides(createBoard(), active({ source: "base", shape: "J" }, -1, 0))).toBe(true);
    expect(collides(createBoard(), active({ source: "base", shape: "T" }, 3, 21))).toBe(true);
    expect(collides(createBoard(), active({ source: "monomino", shape: "monomino" }, 4, -1)))
      .toBe(true);
    expect(collides(createBoard(), active({ source: "base", shape: "T" }, 3, 0))).toBe(false);
  });

  it("tests spawn and grounded state through piece geometry", () => {
    const grid = createBoard();
    const descriptor = { source: "base", shape: "O" } as const;
    const floorPiece = active(descriptor, 3, 20);

    expect(canSpawn(grid, descriptor)).toBe(true);
    grid[0]![4] = { kind: "J" };
    expect(canSpawn(grid, descriptor)).toBe(false);
    expect(isGrounded(createBoard(), floorPiece)).toBe(true);
    expect(isGrounded(createBoard(), active(descriptor, 3, 19))).toBe(false);
  });

  it("checks only the eight occupied Hollow Cross cells, not its empty center", () => {
    const centerOnly = createBoard();
    centerOnly[2]![4] = { kind: "garbage" };
    const armBlocked = createBoard();
    armBlocked[2]![5] = { kind: "garbage" };
    const cross = active({ source: "cross", shape: "cross" }, 2, 0);

    expect(collides(centerOnly, cross)).toBe(false);
    expect(collides(armBlocked, cross)).toBe(true);
  });
});

describe("piece movement", () => {
  it("spawns a valid descriptor with the configured lock state and rejects a blocked spawn", () => {
    const descriptor = { source: "base", shape: "O" } as const;
    const grid = createBoard();

    expect(spawnPiece(grid, descriptor)).toEqual({
      descriptor,
      x: 3,
      y: 0,
      rotation: 0,
      lockTicksRemaining: 30,
      lockResetCount: 0,
    });
    grid[0]![4] = { kind: "garbage" };
    expect(spawnPiece(grid, descriptor)).toBeNull();
  });

  it("moves through open cells, records the logical action, and rejects collisions", () => {
    const grid = createBoard();
    const original = active({ source: "base", shape: "T" }, 3, 4);

    expect(tryMove(grid, original, 1, 0)).toEqual({
      ...original,
      x: 4,
      lastSuccessfulAction: "move",
    });
    expect(tryMove(grid, active({ source: "base", shape: "J" }, 0, 4), -1, 0)).toBeNull();
    expect(tryMove(grid, original, 0, 1, "soft-drop")).toEqual({
      ...original,
      y: 5,
      lastSuccessfulAction: "soft-drop",
    });
    expect(original).toEqual(active({ source: "base", shape: "T" }, 3, 4));
  });

  it("lets gravity descend without replacing the last successful player action", () => {
    const rotated = {
      ...active({ source: "base", shape: "T" }, 3, 4, 1),
      lastSuccessfulAction: "rotate-cw" as const,
    };

    expect(tryGravityStep(createBoard(), rotated)).toEqual({ ...rotated, y: 5 });
  });

  it("resets a grounded manipulation to 30 ticks no more than 15 times", () => {
    const grid = createBoard();
    const grounded = {
      ...active({ source: "base", shape: "O" }, 3, 20),
      lockTicksRemaining: 7,
      lockResetCount: 14,
    };
    const capped = { ...grounded, lockResetCount: 15 };
    const airborne = { ...grounded, y: 10 };

    expect(tryMove(grid, grounded, -1, 0)).toMatchObject({
      x: 2,
      lockTicksRemaining: 30,
      lockResetCount: 15,
    });
    expect(tryMove(grid, capped, -1, 0)).toMatchObject({
      x: 2,
      lockTicksRemaining: 7,
      lockResetCount: 15,
    });
    expect(tryMove(grid, airborne, -1, 0)).toMatchObject({
      x: 2,
      lockTicksRemaining: 7,
      lockResetCount: 14,
    });
  });

  it("applies the first collision-free SRS kick and records rotation direction", () => {
    const grid = createBoard();
    const againstLeftWall = active({ source: "base", shape: "T" }, -1, 4, 1);

    expect(collides(grid, againstLeftWall)).toBe(false);
    expect(tryRotate(grid, againstLeftWall, "ccw")).toEqual({
      ...againstLeftWall,
      x: 0,
      rotation: 0,
      lastSuccessfulAction: "rotate-ccw",
    });
    expect(tryRotate(grid, active({ source: "cross", shape: "cross" }, 2, 4), "cw"))
      .toBeNull();
  });

  it("treats O rotation as a true no-op without a lock reset", () => {
    const groundedO = {
      ...active({ source: "base", shape: "O" }, 3, 20),
      lockTicksRemaining: 4,
      lockResetCount: 6,
    };

    expect(tryRotate(createBoard(), groundedO, "cw")).toBeNull();
    expect(groundedO).toMatchObject({ lockTicksRemaining: 4, lockResetCount: 6 });
  });

  it("computes the exact ghost landing and makes hard drop lock immediately", () => {
    const grid = createBoard();
    const piece = active({ source: "base", shape: "T" }, 3, 0);

    expect(getGhostY(grid, piece)).toBe(20);
    expect(getDropDistance(grid, piece)).toBe(20);
    expect(hardDrop(grid, piece)).toEqual({
      distance: 20,
      piece: {
        ...piece,
        y: 20,
        lockTicksRemaining: 0,
        lastSuccessfulAction: "hard-drop",
      },
    });
  });
});
