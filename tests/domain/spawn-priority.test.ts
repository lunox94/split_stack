import { describe, expect, it } from "vitest";
import {
  completeReplacementPiece,
  createPieceFactory,
  createPlayerState,
  selectSpawnDescriptor,
} from "../../src/domain/state";

const SEED = "00112233445566778899aabbccddeeff";

describe("spawn priority", () => {
  it("plays forced FIFO, then a pending three-acid mode, then resumes base cursor", () => {
    const factory = createPieceFactory(SEED);
    let player = createPlayerState("player-a", SEED);
    player.forcedQueue = [
      { source: "cross", shape: "cross", eventId: "cross:1" },
      { source: "glitch", shape: "T", eventId: "glitch:1" },
    ];
    player.pendingReplacementModes = ["acid-rain"];

    const sources: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const selected = selectSpawnDescriptor(player, factory);
      player = selected.state;
      sources.push(selected.descriptor.source);
      if (selected.descriptor.source === "acid") {
        player = completeReplacementPiece(player);
      }
    }

    expect(sources).toEqual(["cross", "glitch", "acid", "acid", "acid", "base"]);
    expect(player.basePieceCursor).toBe(1);
    expect(player.replacementMode).toBeNull();
  });

  it("does not let a newly arrived forced piece interrupt an active mode", () => {
    const factory = createPieceFactory(SEED);
    let player = createPlayerState("player-a", SEED);
    player.pendingReplacementModes = ["acid-rain"];

    let selected = selectSpawnDescriptor(player, factory);
    player = completeReplacementPiece(selected.state);
    player.forcedQueue.push({ source: "cross", shape: "cross", eventId: "late" });
    selected = selectSpawnDescriptor(player, factory);

    expect(selected.descriptor.source).toBe("acid");
    expect(selected.state.forcedQueue).toHaveLength(1);
  });

  it("attaches deterministic markers only to base descriptors", () => {
    const factory = createPieceFactory(SEED);
    const descriptors = Array.from({ length: 20 }, (_, index) => factory.baseAt(index));

    expect(descriptors.filter((piece) => piece.specialCellIndex !== undefined)).toHaveLength(2);
    expect(descriptors.every((piece) => piece.source === "base")).toBe(true);
  });
});

