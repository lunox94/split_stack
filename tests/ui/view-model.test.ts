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

  it("projects no board cells when Blackout conceals a remote owner", () => {
    const snapshot = createSimulation({
      seed: "00112233445566778899aabbccddeeff",
      playerId: "a",
      practice: true,
    }).readSnapshot();

    expect(boardModelFromSimulation(snapshot, false, true).cells).toEqual([]);
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
