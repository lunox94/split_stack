import { describe, expect, it } from "vitest";
import { createBoard } from "../../src/domain/board";
import { spawnPiece } from "../../src/domain/movement";
import { createSimulation } from "../../src/domain/simulation";
import { createGlitchDescriptor } from "../../src/domain/specials";
import { createPlayerState } from "../../src/domain/state";

const SEED = "00112233445566778899aabbccddeeff";

describe("simulation facade", () => {
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
    const snapshot = simulation.readSnapshot();

    expect(snapshot.player.lines).toBe(1);
    expect(snapshot.player.score).toBe(100);
    expect(snapshot.player.powerCharge).toBe(1);
    expect(snapshot.player.comboIndex).toBe(0);
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
    player.grid[21]![0] = { kind: "J", special: "garbage-core" };
    player.active = spawnPiece(player.grid, { source: "base", shape: "O" });
    player.active!.x = 3;
    player.active!.y = 20;
    player.powerCharge = 19;
    player.upcomingPower = "barrier";
    player.incomingGarbage = [{ id: "incoming", rows: 1, readyTick: 0, hole: 2 }];
    const simulation = createSimulation({
      seed: SEED,
      playerId: "a",
      practice: false,
      initialPlayer: player,
    });

    const effects = simulation.dispatch("hard-drop");

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
    expect(simulation.readSnapshot().player.statuses).toContainEqual({
      kind: "barrier",
      remainingTicks: 1_200,
      capacity: 4,
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

    const attacks = simulation
      .dispatch("hard-drop")
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

    const attacks = simulation
      .dispatch("hard-drop")
      .filter((effect) => effect.kind === "garbage-attack");

    expect(attacks).toEqual([
      { kind: "garbage-attack", rows: 4, eventId: "a:0:1:lock:garbage" },
    ]);
    expect(simulation.readSnapshot().player.stats.garbageSent).toBe(4);
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
});
