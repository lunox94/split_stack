import { describe, expect, it } from "vitest";
import { boardModelFromSimulation } from "../../src/app/view-model";
import { createSimulation } from "../../src/domain/simulation";

describe("board view projection", () => {
  it("projects settled, ghost, and active cells without exposing mutable state", () => {
    const snapshot = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "a",
      practice: true,
    }).readSnapshot();

    const model = boardModelFromSimulation(snapshot, true, false);

    expect(model.focused).toBe(true);
    expect(model.cells.filter((cell) => cell.role === "active")).toHaveLength(4);
    expect(model.cells.filter((cell) => cell.role === "ghost")).toHaveLength(4);
  });

  it("provides a movement-stable active-piece key that changes on spawn", () => {
    const snapshot = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "a",
      practice: true,
    }).readSnapshot();
    if (snapshot.player.active === null) throw new Error("Expected an active piece");
    snapshot.player.active.descriptor.specialKind = "glitch-core";
    snapshot.player.active.descriptor.specialCellIndex = 0;

    const spawned = boardModelFromSimulation(snapshot, true, false).activePieceKey;
    snapshot.player.active.x += 1;
    const moved = boardModelFromSimulation(snapshot, true, false).activePieceKey;
    snapshot.player.basePieceCursor += 1;
    const nextSpawn = boardModelFromSimulation(snapshot, true, false).activePieceKey;

    expect(spawned).toBeDefined();
    expect(moved).toBe(spawned);
    expect(nextSpawn).not.toBe(spawned);
  });

  it("maps each large Cross cell kind for active and ghost projections", () => {
    const snapshot = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "a",
      practice: true,
    }).readSnapshot();
    if (snapshot.player.active === null) throw new Error("Expected an active piece");
    snapshot.player.active.descriptor = {
      source: "cross",
      shape: "cross",
      crossVariant: "large",
    };

    const cells = boardModelFromSimulation(snapshot, true, false).cells;
    const kindsFor = (role: "active" | "ghost") => cells
      .filter((cell) => cell.role === role)
      .map((cell) => cell.kind);

    expect(kindsFor("active")).toEqual(["I", "T", "J", "S", "Z", "L", "O", "cross"]);
    expect(kindsFor("ghost")).toEqual(["I", "T", "J", "S", "Z", "L", "O", "cross"]);
  });

  it("projects active Acid projectiles as acid cells without relaxing board persistence", () => {
    const snapshot = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "a",
      practice: true,
    }).readSnapshot();
    if (snapshot.player.active === null) throw new Error("Expected an active piece");
    snapshot.player.active.descriptor = { source: "acid", shape: "acid" };

    const cells = boardModelFromSimulation(snapshot, true, false).cells;

    expect(cells.filter((cell) => cell.role === "active")).toMatchObject([
      { kind: "acid" },
    ]);
    expect(cells.filter((cell) => cell.role === "ghost")).toMatchObject([
      { kind: "acid" },
    ]);
  });

  it("projects no board cells when Blackout conceals a remote owner", () => {
    const snapshot = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "a",
      practice: true,
    }).readSnapshot();

    expect(boardModelFromSimulation(snapshot, false, true).cells).toEqual([]);
  });

  it("suppresses a Ghost-Jammed board projection for every viewer", () => {
    const snapshot = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "a",
      practice: false,
    }).readSnapshot();
    snapshot.player.statuses.push({ kind: "ghost-jam", remainingTicks: 900 });

    const model = boardModelFromSimulation(snapshot, false, false);

    expect(model.cells.filter((cell) => cell.role === "ghost")).toEqual([]);
    expect(model.cells.filter((cell) => cell.role === "active")).toHaveLength(4);
  });

  it("projects incoming pressure and active defensive/status presentation", () => {
    const snapshot = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "a",
      practice: true,
    }).readSnapshot();
    snapshot.player.incomingGarbage.push({
      id: "incoming-1",
      rows: 3,
      readyTick: 120,
      hole: 4,
    });
    snapshot.player.statuses.push(
      { kind: "barrier", capacity: 3, remainingTicks: 300 },
      { kind: "scramble", remainingTicks: 180 },
    );
    snapshot.player.replacementMode = {
      kind: "monomino-rush",
      remainingTicks: 240,
    };

    expect(boardModelFromSimulation(snapshot, true, false)).toMatchObject({
      incomingGarbage: 3,
      barrierCapacity: 3,
      scrambled: true,
      monominoRush: true,
    });
  });
});
