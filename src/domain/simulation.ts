import { RULES, STANDARD_SHAPES, gravityIntervalFor } from "../config/rules";
import { clearLines, cloneBoard, findCompleteLines, mergePiece } from "./board";
import { applyReadyGarbage, cancelIncomingGarbage, createGarbagePacket } from "./garbage";
import { hashCanonical } from "./hashing";
import {
  getGhostY,
  hardDrop,
  spawnPiece,
  tryMove,
  tryRotate,
} from "./movement";
import { isGrounded, collides } from "./collision";
import { isHoldable } from "./pieces";
import {
  activateBarrier,
  activateTimedStatus,
  applyCollapse,
  applyNuke,
  dissolveColumn,
  queueReplacementPower,
  tickStatuses,
} from "./powers";
import { resolveClearProgress } from "./scoring";
import {
  captureSpecialTriggers,
  enqueueGlitch,
  enqueueHollowCross,
  resolveSpecialTriggers,
} from "./specials";
import {
  completeReplacementPiece,
  advanceReplacementClock as advanceModeClock,
  createPieceFactory,
  createPlayerState,
  selectSpawnDescriptor,
  type PieceFactory,
} from "./state";
import { classifyTSpin } from "./tspin";
import type {
  BarrierStatus,
  LogicalAction,
  PieceDescriptor,
  PlayerGameState,
  PowerKind,
} from "./types";

export interface SimulationOptions {
  seed: string;
  playerId: string;
  practice: boolean;
  initialPlayer?: PlayerGameState;
}

export type ResolutionPhase =
  | "merge"
  | "classify"
  | "capture-specials"
  | "remove-lines"
  | "score-combo-b2b-attack-charge"
  | "resolve-specials"
  | "cancel-incoming"
  | "emit-attacks"
  | "activate-power"
  | "resolve-immediate-power"
  | "apply-ready-garbage"
  | "check-top-out"
  | "spawn-next";

export interface SimulationEffect {
  kind:
    | "piece-locked"
    | "line-clear"
    | "garbage-attack"
    | "hollow-cross"
    | "glitch-piece"
    | "blackout-start"
    | "scramble-start"
    | "power-activated"
    | "nuke"
    | "collapse"
    | "garbage-rise"
    | "top-out"
    | "hold";
  eventId?: string;
  rows?: number;
  power?: PowerKind;
  value?: number;
}

export interface SimulationSnapshot {
  tick: number;
  level: number;
  paused: boolean;
  player: PlayerGameState;
  ghostY: number | null;
  preview: PieceDescriptor[];
  stateHash: number;
}

export interface SimulationCheckpoint {
  tick: number;
  level: number;
  player: PlayerGameState;
  gravityCountdown: number;
  gravityStep: number;
  eventOrdinal: number;
}

export interface Simulation {
  dispatch(action: LogicalAction): SimulationEffect[];
  tick(count?: number): SimulationEffect[];
  setPaused(paused: boolean): void;
  readSnapshot(): SimulationSnapshot;
  checkpoint(): SimulationCheckpoint;
  restore(checkpoint: SimulationCheckpoint): void;
  readLastResolutionTrace(): readonly ResolutionPhase[];
  receiveGarbage(
    rows: number,
    eventId: string,
    senderId?: string,
    sourceTick?: number,
  ): void;
  receiveHollowCross(eventId: string): void;
  receiveGlitch(eventId: string): void;
  receiveScramble(): void;
  activatePower(power: PowerKind): SimulationEffect[];
}

function cloneDescriptor(descriptor: PieceDescriptor): PieceDescriptor {
  return {
    ...descriptor,
    ...(descriptor.previewCosmetics === undefined
      ? {}
      : {
          previewCosmetics: {
            ...descriptor.previewCosmetics,
            shapes: [...descriptor.previewCosmetics.shapes],
          },
        }),
  };
}

function descriptorForPreview(descriptor: PieceDescriptor): PieceDescriptor {
  if (descriptor.source !== "glitch") return cloneDescriptor(descriptor);
  return {
    source: "glitch",
    shape: STANDARD_SHAPES[0],
    previewCosmetics: {
      kind: "glitch-cycle",
      shapes: [...STANDARD_SHAPES],
      intervalMs: RULES.special.glitchCycleMs,
      finalShapeConcealed: true,
    },
  };
}

function clonePlayer(player: PlayerGameState): PlayerGameState {
  return {
    ...player,
    grid: cloneBoard(player.grid),
    active:
      player.active === null
        ? null
        : { ...player.active, descriptor: cloneDescriptor(player.active.descriptor) },
    hold: player.hold === null ? null : cloneDescriptor(player.hold),
    forcedQueue: player.forcedQueue.map(cloneDescriptor),
    pendingReplacementModes: [...player.pendingReplacementModes],
    replacementMode: player.replacementMode === null ? null : { ...player.replacementMode },
    statuses: player.statuses.map((status) => ({ ...status })),
    incomingGarbage: player.incomingGarbage.map((packet) => ({ ...packet })),
    specialSchedule: { ...player.specialSchedule },
    stats: { ...player.stats },
    topOut: player.topOut === null ? null : { ...player.topOut },
  };
}

class LocalSimulation implements Simulation {
  readonly #seed: string;
  readonly #practice: boolean;
  readonly #factory: PieceFactory;
  #player: PlayerGameState;
  #tick = 0;
  #level = 1;
  #paused = false;
  #gravityCountdown: number = RULES.gravity.levelOneThroughEightTicks[0];
  #gravityStep = 0;
  #eventOrdinal = 0;
  #lastTrace: ResolutionPhase[] = [];

  constructor(options: SimulationOptions) {
    this.#seed = options.seed;
    this.#practice = options.practice;
    this.#factory = createPieceFactory(options.seed);
    this.#player = clonePlayer(
      options.initialPlayer ?? createPlayerState(options.playerId, options.seed),
    );
    if (this.#player.active === null && this.#player.topOut === null) this.#spawnNext([]);
  }

  #nextEventId(purpose: string): string {
    this.#eventOrdinal += 1;
    return `${this.#player.playerId}:${this.#tick}:${this.#eventOrdinal}:${purpose}`;
  }

  #spawnDescriptor(descriptor: PieceDescriptor, effects: SimulationEffect[]): void {
    const active = spawnPiece(this.#player.grid, descriptor);
    if (active === null) {
      this.#player.active = null;
      this.#player.topOut = { tick: this.#tick, reason: "spawn" };
      this.#player.stats.topOutTick = this.#tick;
      effects.push({ kind: "top-out", eventId: this.#nextEventId("top-out") });
      return;
    }
    this.#player.active = active;
    this.#gravityCountdown = gravityIntervalFor(this.#level, this.#gravityStep);
  }

  #spawnNext(effects: SimulationEffect[]): void {
    if (this.#player.topOut !== null) return;
    const selection = selectSpawnDescriptor(this.#player, this.#factory);
    this.#player = selection.state;
    this.#spawnDescriptor(selection.descriptor, effects);
  }

  #hold(effects: SimulationEffect[]): void {
    const active = this.#player.active;
    if (active === null || this.#player.holdUsed || !isHoldable(active.descriptor)) return;
    const outgoing = cloneDescriptor(active.descriptor);
    const incoming = this.#player.hold;
    this.#player.hold = outgoing;
    this.#player.active = null;
    this.#player.holdUsed = true;
    if (incoming === null) {
      const selection = selectSpawnDescriptor(this.#player, this.#factory);
      this.#player = selection.state;
      this.#spawnDescriptor(selection.descriptor, effects);
    } else {
      this.#spawnDescriptor(cloneDescriptor(incoming), effects);
    }
    effects.push({ kind: "hold" });
  }

  dispatch(action: LogicalAction): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    const active = this.#player.active;
    if (this.#paused || active === null || this.#player.topOut !== null) return effects;

    if (action === "hold") {
      this.#hold(effects);
      return effects;
    }
    if (action === "move-left" || action === "move-right") {
      const moved = tryMove(
        this.#player.grid,
        active,
        action === "move-left" ? -1 : 1,
        0,
        "move",
      );
      if (moved !== null) this.#player.active = moved;
      return effects;
    }
    if (action === "rotate-cw" || action === "rotate-ccw") {
      const rotated = tryRotate(
        this.#player.grid,
        active,
        action === "rotate-cw" ? "cw" : "ccw",
      );
      if (rotated !== null) this.#player.active = rotated;
      return effects;
    }
    if (action === "soft-drop") {
      const moved = tryMove(this.#player.grid, active, 0, 1, "soft-drop");
      if (moved !== null) {
        this.#player.active = moved;
        if (active.descriptor.source !== "acid") this.#player.score += RULES.scoring.softDrop;
      } else if (active.descriptor.source === "acid") {
        effects.push(...this.#resolveAcid());
      }
      return effects;
    }

    const dropped = hardDrop(this.#player.grid, active);
    this.#player.active = dropped.piece;
    if (active.descriptor.source === "acid") effects.push(...this.#resolveAcid());
    else {
      this.#player.score += dropped.distance * RULES.scoring.hardDrop;
      effects.push(...this.#lockCurrent());
    }
    return effects;
  }

  #resolveAcid(): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    const active = this.#player.active;
    if (active === null || active.descriptor.source !== "acid") return effects;
    this.#player.grid = dissolveColumn(this.#player.grid, active.x).grid;
    this.#player.active = null;
    this.#player.holdUsed = false;
    this.#player = completeReplacementPiece(this.#player);
    this.#spawnNext(effects);
    return effects;
  }

  #recordClearStats(clearKind: string): void {
    if (clearKind === "tetris") this.#player.stats.tetrises += 1;
    else if (clearKind === "t-spin-single") this.#player.stats.tSpinSingles += 1;
    else if (clearKind === "t-spin-double") this.#player.stats.tSpinDoubles += 1;
    else if (clearKind === "t-spin-triple") this.#player.stats.tSpinTriples += 1;
  }

  #applyReadyGarbage(effects: SimulationEffect[]): void {
    const barrier = this.#player.statuses.find(
      (status): status is BarrierStatus => status.kind === "barrier",
    ) ?? null;
    const result = applyReadyGarbage(
      this.#player.grid,
      this.#player.incomingGarbage,
      this.#tick,
      barrier,
    );
    this.#player.grid = result.grid;
    this.#player.incomingGarbage = result.incoming;
    this.#player.statuses = [
      ...this.#player.statuses.filter((status) => status.kind !== "barrier"),
      ...(result.barrier === null ? [] : [result.barrier]),
    ];
    if (result.appliedRows > 0) effects.push({ kind: "garbage-rise", rows: result.appliedRows });
    if (result.topOut) {
      this.#player.topOut = { tick: this.#tick, reason: "garbage" };
      this.#player.stats.topOutTick = this.#tick;
    }
  }

  #activate(power: PowerKind, effects: SimulationEffect[]): void {
    this.#player.stats.powersActivated += 1;
    effects.push({ kind: "power-activated", power });
    if (power === "blackout") {
      this.#player.statuses = activateTimedStatus(this.#player.statuses, "blackout");
      effects.push({ kind: "blackout-start", eventId: this.#nextEventId("blackout") });
    } else if (power === "scramble") {
      effects.push({ kind: "scramble-start", eventId: this.#nextEventId("scramble") });
    } else if (power === "nuke") {
      const result = applyNuke(this.#player.grid);
      this.#player.grid = result.grid;
      effects.push({ kind: "nuke", value: result.removed });
    } else if (power === "barrier") {
      this.#player.statuses = activateBarrier(this.#player.statuses);
    } else if (power === "collapse") {
      const result = applyCollapse(this.#player.grid, this.#level);
      this.#player.grid = result.grid;
      this.#player.score += result.score;
      this.#player.lines += result.clearedLines;
      effects.push({ kind: "collapse", value: result.clearedLines });
    } else {
      this.#player.pendingReplacementModes = queueReplacementPower(
        this.#player.pendingReplacementModes,
        power,
      );
    }
  }

  activatePower(power: PowerKind): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    this.#activate(power, effects);
    return effects;
  }

  #lockCurrent(): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    const active = this.#player.active;
    if (active === null || active.descriptor.source === "acid") return effects;
    const lockEventId = this.#nextEventId("lock");
    this.#lastTrace = [];

    this.#lastTrace.push("merge");
    const merged = mergePiece(this.#player.grid, active);
    this.#lastTrace.push("classify");
    const completed = findCompleteLines(merged);
    const clearKind = classifyTSpin(merged, active, completed.length);
    this.#lastTrace.push("capture-specials");
    const captured = captureSpecialTriggers(merged, completed);
    this.#lastTrace.push("remove-lines");
    this.#player.grid = clearLines(merged, completed);

    this.#lastTrace.push("score-combo-b2b-attack-charge");
    const progress = resolveClearProgress({
      clearKind,
      level: this.#level,
      previousComboIndex: this.#player.comboIndex,
      backToBack: this.#player.backToBack,
      allowCharge: active.descriptor.source !== "monomino",
    });
    this.#player.score += progress.score;
    this.#player.lines += progress.lineCount;
    this.#player.comboIndex = progress.comboIndex;
    this.#player.backToBack = progress.backToBack;
    this.#player.powerCharge += progress.charge;
    this.#recordClearStats(clearKind);
    if (progress.lineCount > 0) {
      effects.push({ kind: "line-clear", rows: progress.lineCount, value: progress.score });
    }
    if (progress.hollowCross) {
      effects.push({ kind: "hollow-cross", eventId: `${lockEventId}:cross` });
    }

    this.#lastTrace.push("resolve-specials");
    const specials = resolveSpecialTriggers(this.#player.grid, captured, this.#seed, lockEventId);
    this.#player.grid = specials.grid;

    this.#lastTrace.push("cancel-incoming");
    const totalAttack = progress.attackRows + specials.garbageCoreEvents.length;
    const canceled = cancelIncomingGarbage(this.#player.incomingGarbage, totalAttack);
    this.#player.incomingGarbage = canceled.incoming;

    this.#lastTrace.push("emit-attacks");
    const canceledRows = totalAttack - canceled.outgoingRows;
    const ordinaryRows = Math.max(0, progress.attackRows - canceledRows);
    const canceledCoreRows = Math.max(0, canceledRows - progress.attackRows);
    const garbageCoreEvents = specials.garbageCoreEvents.slice(canceledCoreRows);
    if (ordinaryRows > 0) {
      effects.push({
        kind: "garbage-attack",
        rows: ordinaryRows,
        eventId: `${lockEventId}:garbage`,
      });
    }
    garbageCoreEvents.forEach((eventId) => {
      effects.push({ kind: "garbage-attack", rows: 1, eventId });
    });
    this.#player.stats.garbageSent += canceled.outgoingRows;
    specials.glitchEvents.forEach((eventId) => {
      effects.push({ kind: "glitch-piece", eventId });
    });

    this.#lastTrace.push("activate-power");
    let activated: PowerKind | null = null;
    if (this.#player.powerCharge >= RULES.power.threshold) {
      activated = this.#player.upcomingPower;
      this.#player.powerCharge = 0;
      this.#player.powerDeckCursor += 1;
      this.#player.upcomingPower = this.#factory.powerAt(this.#player.powerDeckCursor);
    }
    this.#lastTrace.push("resolve-immediate-power");
    if (activated !== null) this.#activate(activated, effects);

    this.#lastTrace.push("apply-ready-garbage");
    this.#applyReadyGarbage(effects);
    this.#lastTrace.push("check-top-out");
    if (this.#player.topOut !== null) {
      effects.push({ kind: "top-out", eventId: this.#nextEventId("top-out") });
      this.#player.active = null;
      return effects;
    }

    this.#player.active = null;
    this.#player.holdUsed = false;
    this.#player = completeReplacementPiece(this.#player);
    this.#lastTrace.push("spawn-next");
    this.#spawnNext(effects);
    effects.push({ kind: "piece-locked", eventId: lockEventId });
    return effects;
  }

  #tickOne(): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    if (this.#paused || this.#player.topOut !== null) return effects;
    this.#tick += 1;
    this.#level = Math.floor(this.#tick / RULES.timing.levelTicks) + 1;
    this.#player.statuses = tickStatuses(this.#player.statuses);
    this.#player = advanceModeClock(this.#player);
    const active = this.#player.active;
    if (active === null) {
      this.#spawnNext(effects);
      return effects;
    }

    if (isGrounded(this.#player.grid, active)) {
      if (active.descriptor.source === "acid") return this.#resolveAcid();
      active.lockTicksRemaining -= 1;
      if (active.lockTicksRemaining <= 0) effects.push(...this.#lockCurrent());
      return effects;
    }

    this.#gravityCountdown -= 1;
    if (this.#gravityCountdown > 0) return effects;
    const falling = { ...active, y: active.y + 1 };
    if (!collides(this.#player.grid, falling)) this.#player.active = falling;
    else if (active.descriptor.source === "acid") effects.push(...this.#resolveAcid());
    this.#gravityStep += 1;
    this.#gravityCountdown = gravityIntervalFor(this.#level, this.#gravityStep);
    return effects;
  }

  tick(count = 1): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    const ticks = Math.max(0, Math.floor(count));
    for (let index = 0; index < ticks; index += 1) effects.push(...this.#tickOne());
    return effects;
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  checkpoint(): SimulationCheckpoint {
    return {
      tick: this.#tick,
      level: this.#level,
      player: clonePlayer(this.#player),
      gravityCountdown: this.#gravityCountdown,
      gravityStep: this.#gravityStep,
      eventOrdinal: this.#eventOrdinal,
    };
  }

  restore(checkpoint: SimulationCheckpoint): void {
    this.#tick = checkpoint.tick;
    this.#level = checkpoint.level;
    this.#player = clonePlayer(checkpoint.player);
    this.#gravityCountdown = checkpoint.gravityCountdown;
    this.#gravityStep = checkpoint.gravityStep;
    this.#eventOrdinal = checkpoint.eventOrdinal;
  }

  readSnapshot(): SimulationSnapshot {
    const player = clonePlayer(this.#player);
    const ghostY =
      player.active === null || collides(player.grid, player.active)
        ? null
        : getGhostY(player.grid, player.active);
    const previewState = clonePlayer(player);
    previewState.active = null;
    const preview: PieceDescriptor[] = [];
    for (let index = 0; index < 5; index += 1) {
      const selected = selectSpawnDescriptor(previewState, this.#factory);
      preview.push(descriptorForPreview(selected.descriptor));
      Object.assign(previewState, selected.state);
      if (selected.descriptor.source === "acid") {
        Object.assign(previewState, completeReplacementPiece(previewState));
      }
    }
    return {
      tick: this.#tick,
      level: this.#level,
      paused: this.#paused,
      player,
      ghostY,
      preview,
      stateHash: hashCanonical({
        tick: this.#tick,
        level: this.#level,
        player,
        gravityCountdown: this.#gravityCountdown,
        gravityStep: this.#gravityStep,
      }),
    };
  }

  readLastResolutionTrace(): readonly ResolutionPhase[] {
    return [...this.#lastTrace];
  }

  receiveGarbage(
    rows: number,
    eventId: string,
    senderId?: string,
    sourceTick?: number,
  ): void {
    const attackTick = sourceTick ?? this.#tick;
    const packet = createGarbagePacket(
      this.#seed,
      eventId,
      rows,
      attackTick + RULES.garbage.warningTicks,
      this.#player.lastGarbageHole,
      senderId,
    );
    this.#player.lastGarbageHole = packet.hole;
    this.#player.incomingGarbage.push(packet);
  }

  receiveHollowCross(eventId: string): void {
    const queued = enqueueHollowCross(this.#player.forcedQueue, eventId);
    this.#player.forcedQueue = queued.queue;
    if (queued.overflowGarbageRows > 0) {
      this.receiveGarbage(queued.overflowGarbageRows, `${eventId}:overflow`);
    }
  }

  receiveGlitch(eventId: string): void {
    const queued = enqueueGlitch(this.#player.forcedQueue, this.#seed, eventId);
    this.#player.forcedQueue = queued.queue;
    if (queued.overflowGarbageRows > 0) {
      this.receiveGarbage(queued.overflowGarbageRows, `${eventId}:overflow`);
    }
  }

  receiveScramble(): void {
    this.#player.statuses = activateTimedStatus(this.#player.statuses, "scramble");
  }
}

export function createSimulation(options: SimulationOptions): Simulation {
  return new LocalSimulation(options);
}
