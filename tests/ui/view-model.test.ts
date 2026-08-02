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
});

