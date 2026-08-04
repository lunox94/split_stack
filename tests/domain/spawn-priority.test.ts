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
    const descriptors = Array.from({ length: 18 }, (_, index) => factory.baseAt(index));

    expect(descriptors.filter((piece) => piece.specialCellIndex !== undefined)).toHaveLength(3);
    expect(descriptors.every((piece) => piece.source === "base")).toBe(true);
  });

  it("creates mode-specific player power decks and a separate Oversize shape cursor", () => {
    const competitiveFactory = createPieceFactory(SEED, "competitive");
    const practiceFactory = createPieceFactory(SEED, "practice");
    const competitive = createPlayerState("competitive", SEED, "competitive");
    const practice = createPlayerState("practice", SEED, "practice");

    expect(competitive.upcomingPower).toBe(competitiveFactory.powerAt(0));
    expect(practice.upcomingPower).toBe(practiceFactory.powerAt(0));
    expect(practiceFactory.powerAt(0)).toBeOneOf([
      "nuke", "collapse", "monomino-rush", "acid-rain",
    ]);
    expect(Array.from({ length: 6 }, (_, index) => competitiveFactory.oversizeAt(index)).sort())
      .toEqual(["I", "J", "L", "S", "T", "Z"]);
    expect(competitive.oversizePieceCursor).toBe(0);
  });
});
