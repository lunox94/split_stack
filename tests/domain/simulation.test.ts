import { describe, expect, expectTypeOf, it } from "vitest";
import { createBoard } from "../../src/domain/board";
import { spawnPiece } from "../../src/domain/movement";
import { createSimulation } from "../../src/domain/simulation";
import { createGlitchDescriptor } from "../../src/domain/specials";
import { createPlayerState } from "../../src/domain/state";
import type { HollowCrossVariant } from "../../src/domain/types";

const SEED = "00112233445566778899aabbccddeeff";

describe("simulation facade", () => {
  it("exposes cheap tick and status queries without requiring a rendered snapshot", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: false });

    expect(simulation.currentTick()).toBe(0);
    expect(simulation.hasStatus("scramble")).toBe(false);

    simulation.tick(3);
    simulation.receiveScramble();

    expect(simulation.currentTick()).toBe(3);
    expect(simulation.hasStatus("scramble")).toBe(true);
  });

  it("classifies accepted and rejected movement while preserving dispatch effects", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: false });
    const accepted = simulation.dispatchWithResult("move-left");

    expect(accepted).toEqual({ accepted: true, effects: [] });

    let rejected = simulation.dispatchWithResult("move-left");
    while (rejected.accepted) rejected = simulation.dispatchWithResult("move-left");

    expect(rejected).toEqual({ accepted: false, effects: [] });
    expect(simulation.dispatch("move-left")).toEqual(rejected.effects);
  });

  it("starts with a base piece and hard drop locks immediately into the next piece", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: true });
    const before = simulation.readSnapshot();

    const effects = simulation.dispatch("hard-drop");
    const after = simulation.readSnapshot();

    expect(before.player.active?.descriptor).toMatchObject({ source: "base", shape: "Z" });
    expect(
      after.player.grid.reduce(
        (count, row) => count + row.filter((cell) => cell !== null).length,
        0,
      ),
    ).toBe(4);
    expect(after.player.active?.descriptor).toMatchObject({ source: "base", shape: "S" });
    expect(after.player.basePieceCursor).toBe(2);
    expect(after.player.score).toBeGreaterThan(0);
    expect(effects.some((effect) => effect.kind === "piece-locked")).toBe(true);
  });

  it("preserves a marked base descriptor through Hold and limits Hold to once per lock", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: true });
    const first = simulation.readSnapshot().player.active?.descriptor;

    simulation.dispatch("hold");
    const held = simulation.readSnapshot();
    simulation.dispatch("hold");
    const ignored = simulation.readSnapshot();

    expect(held.player.hold).toEqual(first);
    expect(held.player.active?.descriptor).not.toEqual(first);
    expect(ignored.player).toEqual(held.player);

    simulation.dispatch("hard-drop");
    simulation.dispatch("hold");
    expect(simulation.readSnapshot().player.active?.descriptor).toEqual(first);
  });

  it("accepts marked O identity rotation and checkpoints its strategic orientation", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.active = spawnPiece(player.grid, {
      source: "base",
      shape: "O",
      specialCellIndex: 0,
      specialKind: "column-bomb",
    });
    player.active!.y = 10;
    player.active!.lockTicksRemaining = 7;
    player.active!.lockResetCount = 6;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });
    const before = simulation.readSnapshot();

    expect(simulation.dispatchWithResult("rotate-ccw")).toEqual({
      accepted: true,
      effects: [],
    });
    const rotated = simulation.readSnapshot();

    expect(rotated.player.active).toMatchObject({
      descriptor: {
        shape: "O",
        specialCellIndex: 0,
        specialKind: "column-bomb",
      },
      x: 3,
      y: 10,
      rotation: 3,
      lockTicksRemaining: 7,
      lockResetCount: 6,
      lastSuccessfulAction: "rotate-ccw",
    });
    expect(rotated.stateHash).not.toBe(before.stateHash);

    const restored = createSimulation({ seed: SEED, playerId: "a", practice: true });
    restored.restore(simulation.checkpoint());
    expect(restored.readSnapshot()).toEqual(rotated);
  });

  it("performs normal clear scoring and charge in one lock transaction", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    player.basePieceCursor = 1;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    const effects = simulation.tick(9);
    const snapshot = simulation.readSnapshot();

    expect(snapshot.player.lines).toBe(1);
    expect(snapshot.player.score).toBe(100);
    expect(snapshot.player.powerCharge).toBe(1);
    expect(snapshot.player.comboIndex).toBe(0);
    expect(effects).toContainEqual(
      expect.objectContaining({
        kind: "line-clear",
        phase: "impact",
        comboCount: 1,
        clearOrigin: "piece",
      }),
    );
  });

  it("holds a completed row for exactly nine ticks before resolving and spawning", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    const startEffects = simulation.dispatch("hard-drop");

    expect(startEffects).toContainEqual(
      expect.objectContaining({
        kind: "line-clear",
        phase: "anticipation",
        cells: Array.from({ length: 10 }, (_, x) => ({ x, y: 21 })),
      }),
    );
    expect(simulation.readSnapshot()).toMatchObject({
      resolution: {
        kind: "line-clear",
        remainingTicks: 9,
        totalTicks: 9,
        rows: [21],
      },
      player: { active: null, lines: 0 },
    });

    expect(simulation.tick(8)).not.toContainEqual(
      expect.objectContaining({ kind: "line-clear", phase: "impact" }),
    );
    expect(simulation.readSnapshot().player.active).toBeNull();

    const impactEffects = simulation.tick(1);

    expect(impactEffects).toContainEqual(
      expect.objectContaining({ kind: "line-clear", phase: "impact", rows: 1 }),
    );
    expect(simulation.readSnapshot().resolution).toBeNull();
    expect(simulation.readSnapshot().player.lines).toBe(1);
    expect(simulation.readSnapshot().player.active).not.toBeNull();
  });

  it("scores a delayed clear at the level where the piece locked", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });
    const checkpoint = simulation.checkpoint();
    simulation.restore({ ...checkpoint, tick: 3_599, level: 1 });

    simulation.dispatch("hard-drop");
    simulation.tick(9);

    expect(simulation.readSnapshot().level).toBe(2);
    expect(simulation.readSnapshot().player.score).toBe(100);
  });

  it("pauses timed powers while a deterministic resolution phase is active", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    player.statuses = [{ kind: "blackout", remainingTicks: 100 }];
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    simulation.tick(9);

    expect(simulation.readSnapshot().player.statuses).toContainEqual({
      kind: "blackout",
      remainingTicks: 100,
    });

    simulation.tick(1);
    expect(simulation.readSnapshot().player.statuses).toContainEqual({
      kind: "blackout",
      remainingTicks: 99,
    });
  });

  it("buffers Hold, one rotation, and the latest horizontal direction for the next piece", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    simulation.dispatch("move-left");
    simulation.dispatch("move-right");
    simulation.dispatch("rotate-cw");
    simulation.dispatch("hold");
    simulation.tick(9);

    const snapshot = simulation.readSnapshot();
    expect(snapshot.player.hold).toMatchObject({ source: "base", shape: "Z" });
    expect(snapshot.player.active).toMatchObject({
      descriptor: { source: "base", shape: "S" },
      x: 4,
      rotation: 1,
    });
  });

  it("restores an in-flight resolution and buffered spawn input deterministically", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    const original = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });
    original.dispatch("hard-drop");
    original.dispatch("rotate-cw");
    original.tick(4);
    const checkpoint = original.checkpoint();

    const expectedEffects = original.tick(5);
    const expected = original.readSnapshot();
    const restored = createSimulation({ seed: SEED, playerId: "a", practice: true });
    restored.restore(checkpoint);

    expect(restored.tick(5)).toEqual(expectedEffects);
    expect(restored.readSnapshot()).toEqual(expected);
  });

  it("includes the event ordinal in the authoritative state hash", () => {
    const baseline = createSimulation({ seed: SEED, playerId: "a", practice: true });
    const checkpoint = baseline.checkpoint();
    const advancedOrdinal = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
    });
    advancedOrdinal.restore({
      ...checkpoint,
      eventOrdinal: checkpoint.eventOrdinal + 1,
    });

    expect(advancedOrdinal.readSnapshot().player).toEqual(
      baseline.readSnapshot().player,
    );
    expect(advancedOrdinal.readSnapshot().stateHash).not.toBe(
      baseline.readSnapshot().stateHash,
    );
  });

  it("requires and checkpoints Cross variants distinctly", () => {
    expectTypeOf<Parameters<ReturnType<typeof createSimulation>["receiveHollowCross"]>>()
      .toEqualTypeOf<[string, HollowCrossVariant]>();

    const small = createSimulation({ seed: SEED, playerId: "a", practice: true });
    small.receiveHollowCross("cross:1", "small");
    const checkpoint = small.checkpoint();
    const restored = createSimulation({ seed: SEED, playerId: "a", practice: true });
    restored.restore(checkpoint);
    const large = createSimulation({ seed: SEED, playerId: "a", practice: true });
    large.receiveHollowCross("cross:1", "large");

    expect(restored.readSnapshot()).toEqual(small.readSnapshot());
    expect(small.readSnapshot().player.forcedQueue).toEqual([
      { source: "cross", shape: "cross", crossVariant: "small", eventId: "cross:1" },
    ]);
    expect(large.readSnapshot().stateHash).not.toBe(small.readSnapshot().stateHash);
  });

  it("spends one meter threshold per resolution and retains overflow charge", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let row = 20; row < 22; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        if (column !== 4) player.grid[row]![column] = { kind: "J" };
      }
    }
    player.active = spawnPiece(player.grid, { source: "base", shape: "I" });
    player.active!.x = 2;
    player.active!.y = 18;
    player.active!.rotation = 1;
    player.powerCharge = 13;
    player.upcomingPower = "nuke";
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    const activationEffects = simulation.tick(9);

    expect(activationEffects).toContainEqual(
      expect.objectContaining({
        kind: "power-activated",
        power: "nuke",
        phase: "anticipation",
      }),
    );
    expect(simulation.readSnapshot().player.powerCharge).toBe(8);
    expect(simulation.readSnapshot().player.stats.powersActivated).toBe(1);
    expect(simulation.readSnapshot().player.statuses).not.toContainEqual(
      expect.objectContaining({ kind: "blackout" }),
    );
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "power-impact",
      power: "nuke",
      remainingTicks: 12,
      totalTicks: 12,
    });

    expect(simulation.tick(11)).not.toContainEqual(
      expect.objectContaining({ kind: "power-impact" }),
    );
    const impactEffects = simulation.tick(1);

    expect(impactEffects).toContainEqual(
      expect.objectContaining({
        kind: "power-impact",
        power: "nuke",
        phase: "impact",
      }),
    );
    expect(impactEffects).toContainEqual(
      expect.objectContaining({ kind: "nuke", phase: "impact" }),
    );
  });

  it("emits a distinct T-Spin effect for audio and presentation", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.grid[20]![3] = { kind: "garbage" };
    player.active = spawnPiece(player.grid, { source: "base", shape: "T" });
    player.active!.x = 3;
    player.active!.y = 20;
    player.active!.lastSuccessfulAction = "rotate-cw";
    player.active!.lockTicksRemaining = 1;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    const effects = simulation.tick(1);

    expect(effects).toContainEqual(expect.objectContaining({ kind: "t-spin" }));
    expect(simulation.readSnapshot().player.score).toBe(400);
  });

  it("executes the approved lock resolution phases in exact order", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.grid[21]![0] = { kind: "J", special: "barrier" };
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    player.powerCharge = 19;
    player.upcomingPower = "nuke";
    player.incomingGarbage = [{ id: "incoming", rows: 3, readyTick: 0, hole: 2 }];
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    const effects = [
      ...simulation.dispatch("hard-drop"),
      ...simulation.tick(9),
      ...simulation.tick(12),
    ];

    expect(simulation.readLastResolutionTrace()).toEqual([
      "merge",
      "classify",
      "capture-specials",
      "remove-lines",
      "score-combo-b2b-attack-charge",
      "resolve-specials",
      "cancel-incoming",
      "emit-attacks",
      "activate-power",
      "resolve-immediate-power",
      "apply-ready-garbage",
      "check-top-out",
      "spawn-next",
    ]);
    expect(effects.some((effect) => effect.kind === "garbage-attack")).toBe(false);
    expect(effects.filter((effect) => effect.kind === "barrier-block")).toEqual([
      { kind: "barrier-block", rows: 3 },
    ]);
    expect(simulation.readSnapshot().player.statuses).toContainEqual({
      kind: "barrier",
      remainingTicks: 1_200,
      capacity: 1,
    });
  });

  it("freezes all gameplay clocks while paused", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: true });
    simulation.setPaused(true);
    simulation.tick(180);

    expect(simulation.readSnapshot().tick).toBe(0);
    simulation.setPaused(false);
    simulation.tick(60);
    expect(simulation.readSnapshot().tick).toBe(60);
  });

  it("leaves ready garbage queued after an acid drop and reports a spawn top-out", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.grid[0]![3] = { kind: "J" };
    player.active = spawnPiece(player.grid, { source: "acid", shape: "acid" });
    player.active!.x = 0;
    player.active!.y = 21;
    player.replacementMode = { kind: "acid-rain", remainingPieces: 1 };
    player.incomingGarbage = [{ id: "ready", rows: 1, readyTick: 0, hole: 6 }];
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    const effects = simulation.dispatch("hard-drop");
    const snapshot = simulation.readSnapshot();

    expect(snapshot.player.incomingGarbage).toEqual([
      { id: "ready", rows: 1, readyTick: 0, hole: 6 },
    ]);
    expect(snapshot.player.topOut).toEqual({ tick: 0, reason: "spawn" });
    expect(effects).toContainEqual(expect.objectContaining({ kind: "top-out" }));
    expect(effects.some((effect) => effect.kind === "garbage-rise")).toBe(false);
  });

  it("keeps Acid controllable until contact, then dissolves its locked column top-to-bottom", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.grid[5]![5] = { kind: "J" };
    player.grid[10]![5] = { kind: "T" };
    player.grid[20]![5] = { kind: "garbage" };
    player.active = spawnPiece(player.grid, { source: "acid", shape: "acid" });
    player.replacementMode = { kind: "acid-rain", remainingPieces: 1 };
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    simulation.dispatch("move-right");
    expect(simulation.readSnapshot().player.active?.x).toBe(5);

    const contactEffects = simulation.dispatch("hard-drop");

    expect(contactEffects).toContainEqual(
      expect.objectContaining({
        kind: "acid-lock",
        column: 5,
        target: { x: 5, y: 4 },
        cells: [
          { x: 5, y: 5 },
          { x: 5, y: 10 },
          { x: 5, y: 20 },
        ],
      }),
    );
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      column: 5,
      remainingTicks: 3,
      nextCellIndex: 0,
    });
    expect(simulation.readSnapshot().player.grid[5]![5]).not.toBeNull();

    const first = simulation.tick(1);
    expect(first).toContainEqual(
      expect.objectContaining({
        kind: "acid-dissolve",
        phase: "dissolve",
        order: 0,
        cells: [{ x: 5, y: 5 }],
      }),
    );
    expect(simulation.readSnapshot().player.grid[5]![5]).toBeNull();
    expect(simulation.readSnapshot().player.grid[10]![5]).not.toBeNull();

    const rest = simulation.tick(2);
    expect(rest.filter((effect) => effect.kind === "acid-dissolve")).toEqual([
      expect.objectContaining({ order: 1, cells: [{ x: 5, y: 10 }] }),
      expect.objectContaining({ order: 2, cells: [{ x: 5, y: 20 }] }),
    ]);
    expect(simulation.readSnapshot().resolution).toBeNull();
    expect(simulation.readSnapshot().player.grid[20]![5]).toBeNull();
    expect(simulation.readSnapshot().player.active?.descriptor.source).toBe("base");
  });

  it("locks Acid on the soft-drop step that first reaches contact", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.grid[2]![4] = { kind: "J" };
    player.active = spawnPiece(player.grid, { source: "acid", shape: "acid" });
    player.replacementMode = { kind: "acid-rain", remainingPieces: 1 };
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    const effects = simulation.dispatch("soft-drop");

    expect(effects).toContainEqual(
      expect.objectContaining({
        kind: "acid-lock",
        column: 4,
        target: { x: 4, y: 1 },
      }),
    );
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      column: 4,
    });

    simulation.dispatch("move-right");
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      column: 4,
    });
  });

  it("locks Acid when lateral movement makes first contact and prevents escape", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.grid[1]![5] = { kind: "J" };
    player.active = spawnPiece(player.grid, { source: "acid", shape: "acid" });
    player.replacementMode = { kind: "acid-rain", remainingPieces: 1 };
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    const contact = simulation.dispatch("move-right");

    expect(contact).toContainEqual(
      expect.objectContaining({
        kind: "acid-lock",
        column: 5,
        target: { x: 5, y: 0 },
      }),
    );
    expect(simulation.readSnapshot().player.active).toBeNull();
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      column: 5,
    });

    simulation.dispatch("move-left");
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      column: 5,
    });
  });

  it("locks an Acid drop that spawns already in contact with the stack", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.grid[1]![4] = { kind: "J" };
    player.active = null;
    player.replacementMode = { kind: "acid-rain", remainingPieces: 1 };

    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    expect(simulation.readSnapshot().player.active).toBeNull();
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      column: 4,
      cells: [{ x: 4, y: 1 }],
    });
  });

  it("locks Acid on the gravity step that first reaches contact", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.grid[2]![4] = { kind: "J" };
    player.active = spawnPiece(player.grid, { source: "acid", shape: "acid" });
    player.replacementMode = { kind: "acid-rain", remainingPieces: 1 };
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    const effects = simulation.tick(48);

    expect(effects).toContainEqual(
      expect.objectContaining({
        kind: "acid-lock",
        column: 4,
        target: { x: 4, y: 1 },
      }),
    );
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      column: 4,
    });
  });

  it("dissolves a full visible Acid column one cell per tick within 333ms", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let row = 2; row < 22; row += 1) {
      player.grid[row]![4] = { kind: "garbage" };
    }
    player.active = spawnPiece(player.grid, { source: "acid", shape: "acid" });
    player.replacementMode = { kind: "acid-rain", remainingPieces: 1 };
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");

    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      remainingTicks: 20,
      totalTicks: 20,
      nextCellIndex: 0,
    });

    const firstNineteen = simulation.tick(19);
    expect(
      firstNineteen.filter((effect) => effect.kind === "acid-dissolve"),
    ).toHaveLength(19);
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "acid-dissolve",
      remainingTicks: 1,
      nextCellIndex: 19,
    });
    expect(simulation.readSnapshot().player.grid[21]![4]).not.toBeNull();

    const last = simulation.tick(1);
    expect(last).toContainEqual(
      expect.objectContaining({
        kind: "acid-dissolve",
        order: 19,
        cells: [{ x: 4, y: 21 }],
      }),
    );
    expect(simulation.readSnapshot().resolution).toBeNull();
  });

  it("sequences Collapse as power cue, then a 400ms drop-and-clear resolution", () => {
    const player = createPlayerState("a", SEED);
    player.comboIndex = 3;
    player.backToBack = true;
    player.grid = createBoard();
    for (let column = 0; column < 9; column += 1) {
      player.grid[21]![column] = { kind: "J" };
    }
    player.grid[19]![9] = { kind: "T", special: "glitch-core" };
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    const cue = simulation.activatePower("collapse");
    expect(cue).toContainEqual(
      expect.objectContaining({ kind: "power-activated", phase: "anticipation" }),
    );
    expect(simulation.readSnapshot().player.grid[19]![9]).not.toBeNull();

    const drop = simulation.tick(12);
    expect(drop).toContainEqual(
      expect.objectContaining({
        kind: "collapse",
        phase: "drop",
        movements: [
          {
            from: { x: 9, y: 19 },
            to: { x: 9, y: 21 },
          },
        ],
      }),
    );
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "collapse-drop",
      remainingTicks: 15,
      rows: [21],
    });
    expect(simulation.readSnapshot().player.grid[21]!.every(Boolean)).toBe(true);

    const anticipation = simulation.tick(15);
    expect(anticipation).toContainEqual(
      expect.objectContaining({ kind: "line-clear", phase: "anticipation", rows: 1 }),
    );
    expect(simulation.readSnapshot().resolution).toMatchObject({
      kind: "collapse-clear",
      remainingTicks: 9,
      rows: [21],
    });

    expect(simulation.tick(8)).not.toContainEqual(
      expect.objectContaining({ kind: "collapse", phase: "impact" }),
    );
    const impact = simulation.tick(1);

    expect(impact).toContainEqual(
      expect.objectContaining({ kind: "collapse", phase: "impact", value: 1 }),
    );
    expect(impact).toContainEqual(
      expect.objectContaining({
        kind: "line-clear",
        phase: "impact",
        comboCount: 4,
        clearOrigin: "power-collapse",
      }),
    );
    expect(simulation.readSnapshot()).toMatchObject({
      resolution: null,
      player: { lines: 1, score: 100, comboIndex: 3, backToBack: true },
    });
    expect(simulation.readSnapshot().tick).toBe(36);
    expect(simulation.readSnapshot().tick - 12).toBe(24);
  });

  it("applies Nuke only at its visible impact and exposes the exact 5x5 blast cells", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.grid[3]![0] = { kind: "T" };
    player.grid[4]![1] = { kind: "J" };
    player.grid[5]![2] = { kind: "L" };
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    const cue = simulation.activatePower("nuke");
    expect(cue).toContainEqual(
      expect.objectContaining({
        kind: "power-activated",
        power: "nuke",
        phase: "anticipation",
        target: { x: 2, y: 3 },
        cells: [
          { x: 0, y: 3 },
          { x: 1, y: 4 },
          { x: 2, y: 5 },
        ],
      }),
    );
    expect(simulation.readSnapshot().player.grid[3]![0]).not.toBeNull();
    expect(simulation.tick(11)).not.toContainEqual(
      expect.objectContaining({ kind: "nuke" }),
    );

    const effects = simulation.tick(1);

    expect(effects).toContainEqual(
      expect.objectContaining({
        kind: "nuke",
        phase: "impact",
        target: { x: 2, y: 3 },
        cells: [
          { x: 0, y: 3 },
          { x: 1, y: 4 },
          { x: 2, y: 5 },
        ],
      }),
    );
    expect(simulation.readSnapshot().player.grid[3]![0]).toBeNull();
  });

  it("measures garbage warning time from an explicit shared attack tick", () => {
    const receivedNow = createSimulation({ seed: SEED, playerId: "a", practice: false });
    receivedNow.tick(25);
    receivedNow.receiveGarbage(2, "legacy", "b");

    const receivedLate = createSimulation({ seed: SEED, playerId: "a", practice: false });
    receivedLate.tick(25);
    receivedLate.receiveGarbage(2, "shared-clock", "b", 10);

    expect(receivedNow.readSnapshot().player.incomingGarbage[0]).toMatchObject({
      id: "legacy",
      senderId: "b",
      readyTick: 175,
    });
    expect(receivedLate.readSnapshot().player.incomingGarbage[0]).toMatchObject({
      id: "shared-clock",
      senderId: "b",
      readyTick: 160,
    });
  });

  it("combines a surviving Garbage Core contribution into the resolution packet", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.grid[21]![0] = { kind: "J", special: "garbage-core" };
    player.grid[21]![1] = { kind: "J", special: "garbage-core" };
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    player.incomingGarbage = [{ id: "cancel-one", rows: 1, readyTick: 0, hole: 7 }];
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    const attacks = simulation
      .tick(9)
      .filter((effect) => effect.kind === "garbage-attack");

    expect(attacks).toEqual([
      {
        kind: "garbage-attack",
        rows: 1,
        eventId: "a:0:1:lock:garbage",
      },
    ]);
    expect(simulation.readSnapshot().player.stats.garbageSent).toBe(1);
  });

  it("combines every uncanceled row from one resolution into one attack packet", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let row = 18; row < 22; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        if (column !== 4) player.grid[row]![column] = { kind: "J" };
      }
    }
    player.grid[21]![0] = { kind: "J", special: "garbage-core" };
    player.grid[20]![0] = { kind: "J", special: "garbage-core" };
    player.active = spawnPiece(player.grid, { source: "base", shape: "I" });
    player.active!.x = 2;
    player.active!.y = 18;
    player.active!.rotation = 1;
    player.incomingGarbage = [{ id: "cancel-one", rows: 1, readyTick: 0, hole: 7 }];
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    const attacks = simulation
      .tick(9)
      .filter((effect) => effect.kind === "garbage-attack");

    expect(attacks).toEqual([
      { kind: "garbage-attack", rows: 4, eventId: "a:0:1:lock:garbage" },
    ]);
    expect(simulation.readSnapshot().player.stats.garbageSent).toBe(4);
  });

  it("emits marked-cell animation events bottom-first then left-to-right", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let row = 20; row < 22; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        if (column !== 4) player.grid[row]![column] = { kind: "J" };
      }
    }
    player.grid[21]![1] = { kind: "J", special: "garbage-core" };
    player.grid[21]![8] = { kind: "J", special: "glitch-core" };
    player.grid[20]![0] = { kind: "J", special: "column-bomb" };
    player.active = spawnPiece(player.grid, { source: "base", shape: "I" });
    player.active!.x = 2;
    player.active!.y = 18;
    player.active!.rotation = 1;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: true,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    const effects = simulation.tick(9);

    expect(effects.filter((effect) => effect.kind === "special-trigger")).toEqual([
      expect.objectContaining({
        kind: "special-trigger",
        special: "garbage-core",
        row: 21,
        column: 1,
        order: 0,
      }),
      expect.objectContaining({
        kind: "special-trigger",
        special: "glitch-core",
        row: 21,
        column: 8,
        order: 1,
      }),
      expect.objectContaining({
        kind: "special-trigger",
        special: "column-bomb",
        row: 20,
        column: 0,
        order: 2,
      }),
    ]);
  });

  it("conceals a pending Glitch's seeded final shape until it spawns", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.forcedQueue = [createGlitchDescriptor(SEED, "glitch:1")];
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    const preview = simulation.readSnapshot().preview[0];

    expect(preview).toEqual({
      source: "glitch",
      shape: "I",
      previewCosmetics: {
        kind: "glitch-cycle",
        shapes: ["I", "J", "L", "O", "S", "T", "Z"],
        intervalMs: 150,
        finalShapeConcealed: true,
      },
    });
    expect(preview).not.toHaveProperty("eventId");

    simulation.dispatch("hard-drop");
    expect(simulation.readSnapshot().player.active?.descriptor).toEqual({
      source: "glitch",
      shape: "L",
      eventId: "glitch:1",
    });
  });

  it("limits a new Practice simulation to the self-benefit meter deck", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: true });

    expect(["nuke", "collapse", "monomino-rush", "acid-rain"]).toContain(
      simulation.readSnapshot().player.upcomingPower,
    );
  });

  it("emits target attack effects for the new meter powers without self-applying them", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: true });

    const oversizeStart = simulation.activatePower("oversize");
    const oversizeImpact = simulation.tick(12);
    expect(oversizeStart).toContainEqual(
      expect.objectContaining({ kind: "power-activated", power: "oversize" }),
    );
    expect(oversizeImpact).toContainEqual(
      expect.objectContaining({ kind: "oversize-piece" }),
    );
    expect(simulation.readSnapshot().player.forcedQueue).toEqual([]);

    const ghostJamStart = simulation.activatePower("ghost-jam");
    const ghostJamImpact = simulation.tick(12);
    expect(ghostJamStart).toContainEqual(
      expect.objectContaining({ kind: "power-activated", power: "ghost-jam" }),
    );
    expect(ghostJamImpact).toContainEqual(
      expect.objectContaining({ kind: "ghost-jam-start" }),
    );
    expect(simulation.readSnapshot().player.statuses).not.toContainEqual(
      expect.objectContaining({ kind: "ghost-jam" }),
    );
  });

  it("preserves an Oversize descriptor through a normal Hold round trip", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    player.active = spawnPiece(player.grid, {
      source: "oversize",
      shape: "T",
      eventId: "oversize:hold",
    });
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    simulation.dispatch("hold");
    expect(simulation.readSnapshot().player.hold).toEqual({
      source: "oversize",
      shape: "T",
      eventId: "oversize:hold",
    });
    simulation.dispatch("hard-drop");
    simulation.dispatch("hold");
    expect(simulation.readSnapshot().player.active?.descriptor).toEqual({
      source: "oversize",
      shape: "T",
      eventId: "oversize:hold",
    });
  });

  it("derives Oversize attacks from a restorable six-shape cursor and converts overflow", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: false });

    const accepted = simulation.receiveOversize("oversize:1");
    const afterAccepted = simulation.readSnapshot();
    const overflow = simulation.receiveOversize("oversize:2");
    const afterOverflow = simulation.readSnapshot();

    expect(accepted).toEqual([
      expect.objectContaining({ kind: "oversize-piece", eventId: "oversize:1" }),
    ]);
    expect(afterAccepted.player.forcedQueue).toEqual([
      expect.objectContaining({ source: "oversize", eventId: "oversize:1" }),
    ]);
    expect(afterAccepted.player.oversizePieceCursor).toBe(1);
    expect(overflow).toEqual([
      { kind: "oversize-overflow", eventId: "oversize:2", rows: 2 },
    ]);
    expect(afterOverflow.player.forcedQueue).toEqual(afterAccepted.player.forcedQueue);
    expect(afterOverflow.player.oversizePieceCursor).toBe(2);
    expect(afterOverflow.player.incomingGarbage).toContainEqual(
      expect.objectContaining({ id: "oversize:2:overflow", rows: 2 }),
    );

    const checkpoint = simulation.checkpoint();
    const restored = createSimulation({ seed: SEED, playerId: "a", practice: false });
    restored.restore(checkpoint);
    expect(restored.readSnapshot().player.oversizePieceCursor).toBe(2);
    expect(restored.readSnapshot().stateHash).toBe(simulation.readSnapshot().stateHash);

    const advancedCursor = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
    });
    advancedCursor.restore({
      ...checkpoint,
      player: {
        ...checkpoint.player,
        oversizePieceCursor: checkpoint.player.oversizePieceCursor + 1,
      },
    });
    expect(advancedCursor.readSnapshot().stateHash).not.toBe(
      simulation.readSnapshot().stateHash,
    );
  });

  it("suppresses the target board's ghost for everyone while Ghost Jam is active", () => {
    const simulation = createSimulation({ seed: SEED, playerId: "a", practice: false });

    expect(simulation.readSnapshot().ghostY).not.toBeNull();
    simulation.receiveGhostJam();
    expect(simulation.readSnapshot()).toMatchObject({
      ghostY: null,
      player: {
        statuses: expect.arrayContaining([
          { kind: "ghost-jam", remainingTicks: 900 },
        ]),
      },
    });

    simulation.tick(1);
    expect(simulation.readSnapshot().player.statuses).toContainEqual({
      kind: "ghost-jam",
      remainingTicks: 899,
    });
    simulation.receiveGhostJam();
    expect(simulation.readSnapshot().player.statuses).toContainEqual({
      kind: "ghost-jam",
      remainingTicks: 900,
    });
  });

  it("activates embedded Blackout and Barrier with canonical reset values", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      if (column !== 4 && column !== 5) player.grid[21]![column] = { kind: "J" };
    }
    player.grid[21]![0] = { kind: "J", special: "blackout" };
    player.grid[21]![1] = { kind: "J", special: "barrier" };
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    const effects = simulation.tick(9);

    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "blackout-start", eventId: "a:0:1:lock:blackout:1" }),
    );
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "barrier-start", eventId: "a:0:1:lock:barrier:1" }),
    );
    expect(simulation.readSnapshot().player.statuses).toEqual(
      expect.arrayContaining([
        { kind: "blackout", remainingTicks: 900 },
        { kind: "barrier", remainingTicks: 1_200, capacity: 4 },
      ]),
    );
  });

  it("emits a Small Cross only for exactly four placement rows", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let row = 18; row < 22; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        if (column !== 4) player.grid[row]![column] = { kind: "J" };
      }
    }
    player.active = spawnPiece(player.grid, { source: "base", shape: "I" });
    player.active!.x = 2;
    player.active!.y = 18;
    player.active!.rotation = 1;
    const simulation = createSimulation({
      seed: SEED, playerId: "a", practice: false, initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    const effects = simulation.tick(9);

    expect(effects).toContainEqual(expect.objectContaining({
      kind: "hollow-cross", crossVariant: "small",
    }));
    expect(simulation.readSnapshot().player.stats.tetrises).toBe(1);
  });

  it("removes and counts five rows while reusing Tetris rewards", () => {
    const player = createPlayerState("a", SEED);
    player.grid = createBoard();
    for (let row = 17; row < 22; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        if (column !== 4) player.grid[row]![column] = { kind: "J" };
      }
    }
    player.active = spawnPiece(player.grid, { source: "oversize", shape: "I" });
    player.active!.x = 2;
    player.active!.y = 17;
    player.active!.rotation = 1;
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    simulation.dispatch("hard-drop");
    const effects = simulation.tick(9);
    const snapshot = simulation.readSnapshot();

    expect(snapshot.player.lines).toBe(5);
    expect(snapshot.player.score).toBe(800);
    expect(snapshot.player.powerCharge).toBe(5);
    expect(snapshot.player.backToBack).toBe(true);
    expect(snapshot.player.stats.tetrises).toBe(1);
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "line-clear", phase: "impact", rows: 5, value: 800 }),
    );
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "garbage-attack", rows: 3 }),
    );
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "hollow-cross", crossVariant: "large" }),
    );
  });
});
