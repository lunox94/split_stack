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
  applyNuke,
  completePreparedCollapse,
  prepareCollapse,
  queueReplacementPower,
  tickStatuses,
  type CollapseMovement,
} from "./powers";
import { resolveClearProgress } from "./scoring";
import {
  captureSpecialTriggers,
  enqueueGlitch,
  enqueueHollowCross,
  enqueueOversize,
  resolveSpecialTriggers,
  type CapturedSpecial,
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
  ActivePiece,
  BarrierStatus,
  ClearKind,
  Coordinate,
  HollowCrossVariant,
  LogicalAction,
  PieceDescriptor,
  PlayerGameState,
  PowerKind,
  SpecialKind,
  StatusState,
  Tick,
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
    | "t-spin"
    | "line-clear"
    | "garbage-attack"
    | "special-trigger"
    | "hollow-cross"
    | "glitch-piece"
    | "oversize-piece"
    | "oversize-overflow"
    | "blackout-start"
    | "barrier-start"
    | "scramble-start"
    | "ghost-jam-start"
    | "power-activated"
    | "power-impact"
    | "nuke"
    | "collapse"
    | "acid-lock"
    | "acid-dissolve"
    | "garbage-rise"
    | "barrier-block"
    | "top-out"
    | "hold";
  eventId?: string;
  rows?: number;
  power?: PowerKind;
  value?: number;
  phase?: "anticipation" | "impact" | "drop" | "dissolve";
  cells?: Coordinate[];
  movements?: CollapseMovement[];
  target?: Coordinate;
  column?: number;
  row?: number;
  order?: number;
  special?: SpecialKind;
  crossVariant?: HollowCrossVariant;
}

export interface LineClearResolution {
  kind: "line-clear";
  remainingTicks: number;
  totalTicks: number;
  rows: number[];
}

export interface PowerImpactResolution {
  kind: "power-impact";
  remainingTicks: number;
  totalTicks: number;
  power: PowerKind;
}

export interface AcidDissolveResolution {
  kind: "acid-dissolve";
  remainingTicks: number;
  totalTicks: number;
  column: number;
  cells: Coordinate[];
  nextCellIndex: number;
}

export interface CollapseDropResolution {
  kind: "collapse-drop";
  remainingTicks: number;
  totalTicks: number;
  rows: number[];
}

export interface CollapseClearResolution {
  kind: "collapse-clear";
  remainingTicks: number;
  totalTicks: number;
  rows: number[];
}

export type SimulationResolution =
  | LineClearResolution
  | PowerImpactResolution
  | AcidDissolveResolution
  | CollapseDropResolution
  | CollapseClearResolution;

export interface BufferedSpawnActions {
  horizontal: "left" | "right" | null;
  rotation: "cw" | "ccw" | null;
  hold: boolean;
}

interface PendingLineClearResolution extends LineClearResolution {
  lockEventId: string;
  lockLevel: number;
  active: ActivePiece;
  clearKind: ClearKind;
  captured: CapturedSpecial[];
}

interface PendingPowerImpactResolution extends PowerImpactResolution {
  eventId: string;
  spawnAfter: boolean;
}

interface PendingAcidDissolveResolution extends AcidDissolveResolution {
  eventId: string;
  ticksUntilNext: number;
}

interface PendingCollapseResolutionBase {
  remainingTicks: number;
  totalTicks: number;
  rows: number[];
  eventId: string;
  spawnAfter: boolean;
  level: number;
}

interface PendingCollapseDropResolution extends PendingCollapseResolutionBase {
  kind: "collapse-drop";
}

interface PendingCollapseClearResolution extends PendingCollapseResolutionBase {
  kind: "collapse-clear";
}

type PendingResolution =
  | PendingLineClearResolution
  | PendingPowerImpactResolution
  | PendingAcidDissolveResolution
  | PendingCollapseDropResolution
  | PendingCollapseClearResolution;

export interface SimulationSnapshot {
  tick: number;
  level: number;
  paused: boolean;
  player: PlayerGameState;
  ghostY: number | null;
  preview: PieceDescriptor[];
  resolution: SimulationResolution | null;
  stateHash: number;
}

export interface SimulationCheckpoint {
  tick: number;
  level: number;
  player: PlayerGameState;
  gravityCountdown: number;
  gravityStep: number;
  eventOrdinal: number;
  resolution: PendingResolution | null;
  bufferedSpawnActions: BufferedSpawnActions;
}

export interface SimulationDispatchResult {
  accepted: boolean;
  effects: SimulationEffect[];
}

export interface Simulation {
  dispatch(action: LogicalAction): SimulationEffect[];
  dispatchWithResult(action: LogicalAction): SimulationDispatchResult;
  currentTick(): Tick;
  hasStatus(kind: StatusState["kind"]): boolean;
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
  receiveHollowCross(eventId: string, crossVariant: HollowCrossVariant): void;
  receiveGlitch(eventId: string): void;
  receiveOversize(
    eventId: string,
    senderId?: string,
    sourceTick?: number,
  ): SimulationEffect[];
  receiveScramble(): void;
  receiveGhostJam(): void;
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

function cloneActivePiece(active: ActivePiece): ActivePiece {
  return { ...active, descriptor: cloneDescriptor(active.descriptor) };
}

function clonePendingResolution(
  resolution: PendingResolution | null,
): PendingResolution | null {
  if (resolution === null) return null;
  if (resolution.kind === "power-impact") return { ...resolution };
  if (resolution.kind === "acid-dissolve") {
    return { ...resolution, cells: resolution.cells.map((cell) => ({ ...cell })) };
  }
  if (resolution.kind === "collapse-drop" || resolution.kind === "collapse-clear") {
    return { ...resolution, rows: [...resolution.rows] };
  }
  return {
    ...resolution,
    rows: [...resolution.rows],
    active: cloneActivePiece(resolution.active),
    captured: resolution.captured.map((trigger) => ({ ...trigger })),
  };
}

function resolutionView(
  resolution: PendingResolution | null,
): SimulationResolution | null {
  if (resolution === null) return null;
  if (resolution.kind === "power-impact") {
    return {
      kind: "power-impact",
      remainingTicks: resolution.remainingTicks,
      totalTicks: resolution.totalTicks,
      power: resolution.power,
    };
  }
  if (resolution.kind === "acid-dissolve") {
    return {
      kind: "acid-dissolve",
      remainingTicks: resolution.remainingTicks,
      totalTicks: resolution.totalTicks,
      column: resolution.column,
      cells: resolution.cells.map((cell) => ({ ...cell })),
      nextCellIndex: resolution.nextCellIndex,
    };
  }
  if (resolution.kind === "collapse-drop" || resolution.kind === "collapse-clear") {
    return {
      kind: resolution.kind,
      remainingTicks: resolution.remainingTicks,
      totalTicks: resolution.totalTicks,
      rows: [...resolution.rows],
    };
  }
  return {
    kind: "line-clear",
    remainingTicks: resolution.remainingTicks,
    totalTicks: resolution.totalTicks,
    rows: [...resolution.rows],
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
  #resolution: PendingResolution | null = null;
  #bufferedSpawnActions: BufferedSpawnActions = {
    horizontal: null,
    rotation: null,
    hold: false,
  };

  constructor(options: SimulationOptions) {
    this.#seed = options.seed;
    this.#practice = options.practice;
    const powerDeckMode = options.practice ? "practice" : "competitive";
    this.#factory = createPieceFactory(options.seed, powerDeckMode);
    this.#player = clonePlayer(
      options.initialPlayer ?? createPlayerState(
        options.playerId,
        options.seed,
        powerDeckMode,
      ),
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
    this.#resolveGroundedAcid(effects);
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

  #bufferSpawnAction(action: LogicalAction): void {
    if (action === "move-left" || action === "move-right") {
      this.#bufferedSpawnActions.horizontal =
        action === "move-left" ? "left" : "right";
    } else if (action === "rotate-cw" || action === "rotate-ccw") {
      this.#bufferedSpawnActions.rotation = action === "rotate-cw" ? "cw" : "ccw";
    } else if (action === "hold") {
      this.#bufferedSpawnActions.hold = true;
    }
  }

  #applyBufferedSpawnActions(effects: SimulationEffect[]): void {
    const buffered = { ...this.#bufferedSpawnActions };
    this.#bufferedSpawnActions = { horizontal: null, rotation: null, hold: false };
    if (buffered.hold) this.#hold(effects);
    const active = this.#player.active;
    if (active === null) return;
    if (buffered.rotation !== null) {
      const rotated = tryRotate(this.#player.grid, active, buffered.rotation);
      if (rotated !== null) this.#player.active = rotated;
    }
    if (buffered.horizontal !== null && this.#player.active !== null) {
      const moved = tryMove(
        this.#player.grid,
        this.#player.active,
        buffered.horizontal === "left" ? -1 : 1,
        0,
        "move",
      );
      if (moved !== null) {
        this.#player.active = moved;
        this.#resolveGroundedAcid(effects);
      }
    }
  }

  dispatch(action: LogicalAction): SimulationEffect[] {
    return this.dispatchWithResult(action).effects;
  }

  dispatchWithResult(action: LogicalAction): SimulationDispatchResult {
    const effects: SimulationEffect[] = [];
    if (this.#paused || this.#player.topOut !== null) {
      return { accepted: false, effects };
    }
    if (this.#resolution !== null) {
      this.#bufferSpawnAction(action);
      return {
        accepted:
          action === "move-left" ||
          action === "move-right" ||
          action === "rotate-cw" ||
          action === "rotate-ccw" ||
          action === "hold",
        effects,
      };
    }
    const active = this.#player.active;
    if (active === null) return { accepted: false, effects };

    if (action === "hold") {
      this.#hold(effects);
      return { accepted: effects.length > 0, effects };
    }
    if (action === "move-left" || action === "move-right") {
      const moved = tryMove(
        this.#player.grid,
        active,
        action === "move-left" ? -1 : 1,
        0,
        "move",
      );
      if (moved !== null) {
        this.#player.active = moved;
        this.#resolveGroundedAcid(effects);
      }
      return { accepted: moved !== null, effects };
    }
    if (action === "rotate-cw" || action === "rotate-ccw") {
      const rotated = tryRotate(
        this.#player.grid,
        active,
        action === "rotate-cw" ? "cw" : "ccw",
      );
      if (rotated !== null) this.#player.active = rotated;
      return { accepted: rotated !== null, effects };
    }
    if (action === "soft-drop") {
      const moved = tryMove(this.#player.grid, active, 0, 1, "soft-drop");
      if (moved !== null) {
        this.#player.active = moved;
        if (active.descriptor.source === "acid") {
          if (isGrounded(this.#player.grid, moved)) effects.push(...this.#resolveAcid());
        } else {
          this.#player.score += RULES.scoring.softDrop;
        }
      } else if (active.descriptor.source === "acid") {
        effects.push(...this.#resolveAcid());
      }
      return {
        accepted: moved !== null || active.descriptor.source === "acid",
        effects,
      };
    }

    const dropped = hardDrop(this.#player.grid, active);
    this.#player.active = dropped.piece;
    if (active.descriptor.source === "acid") effects.push(...this.#resolveAcid());
    else {
      this.#player.score += dropped.distance * RULES.scoring.hardDrop;
      effects.push(...this.#lockCurrent());
    }
    return { accepted: true, effects };
  }

  #resolveAcid(): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    const active = this.#player.active;
    if (active === null || active.descriptor.source !== "acid") return effects;
    const column = active.x;
    const cells = this.#player.grid.flatMap((row, y) =>
      row[column] === null ? [] : [{ x: column, y }],
    );
    const eventId = this.#nextEventId("acid-lock");
    this.#player.active = null;
    effects.push({
      kind: "acid-lock",
      eventId,
      phase: "impact",
      column,
      target: { x: active.x, y: active.y },
      cells: cells.map((cell) => ({ ...cell })),
    });
    if (cells.length > 0) {
      const totalTicks = cells.length * RULES.timing.acidDissolveStepTicks;
      this.#resolution = {
        kind: "acid-dissolve",
        eventId,
        column,
        cells,
        nextCellIndex: 0,
        ticksUntilNext: RULES.timing.acidDissolveStepTicks,
        remainingTicks: totalTicks,
        totalTicks,
      };
      return effects;
    }
    effects.push(...this.#finishAcid());
    return effects;
  }

  #resolveGroundedAcid(effects: SimulationEffect[]): void {
    const active = this.#player.active;
    if (
      active?.descriptor.source === "acid" &&
      isGrounded(this.#player.grid, active)
    ) {
      effects.push(...this.#resolveAcid());
    }
  }

  #finishAcid(): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    this.#player.holdUsed = false;
    this.#player = completeReplacementPiece(this.#player);
    this.#spawnNext(effects);
    this.#applyBufferedSpawnActions(effects);
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
    if (result.blockedRows > 0) {
      effects.push({ kind: "barrier-block", rows: result.blockedRows });
    }
    if (result.topOut) {
      this.#player.topOut = { tick: this.#tick, reason: "garbage" };
      this.#player.stats.topOutTick = this.#tick;
    }
  }

  #schedulePower(power: PowerKind, spawnAfter: boolean): SimulationEffect[] {
    const eventId = this.#nextEventId(`power:${power}`);
    this.#player.stats.powersActivated += 1;
    this.#resolution = {
      kind: "power-impact",
      power,
      eventId,
      spawnAfter,
      remainingTicks: RULES.timing.powerImpactTicks,
      totalTicks: RULES.timing.powerImpactTicks,
    };
    const effect: SimulationEffect = {
      kind: "power-activated",
      power,
      phase: "anticipation",
      eventId,
    };
    if (power === "nuke") {
      const preview = applyNuke(this.#player.grid);
      effect.cells = preview.cells.map((cell) => ({ ...cell }));
      if (preview.target !== null) effect.target = { ...preview.target };
    }
    return [effect];
  }

  #applyPowerImpact(
    power: PowerKind,
    eventId: string,
    effects: SimulationEffect[],
  ): void {
    effects.push({ kind: "power-impact", power, phase: "impact", eventId });
    if (power === "scramble") {
      effects.push({ kind: "scramble-start", eventId });
    } else if (power === "nuke") {
      const result = applyNuke(this.#player.grid);
      this.#player.grid = result.grid;
      effects.push({
        kind: "nuke",
        eventId,
        phase: "impact",
        value: result.removed,
        cells: result.cells.map((cell) => ({ ...cell })),
        ...(result.target === null ? {} : { target: { ...result.target } }),
      });
    } else if (power === "collapse") {
      // Collapse's board mutation is staged by the resolution timeline.
    } else if (power === "monomino-rush" || power === "acid-rain") {
      this.#player.pendingReplacementModes = queueReplacementPower(
        this.#player.pendingReplacementModes,
        power,
      );
    } else if (power === "oversize") {
      effects.push({ kind: "oversize-piece", eventId });
    } else {
      effects.push({ kind: "ghost-jam-start", eventId });
    }
  }

  activatePower(power: PowerKind): SimulationEffect[] {
    if (this.#paused || this.#resolution !== null || this.#player.topOut !== null) return [];
    return this.#schedulePower(power, false);
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
    this.#player.grid = merged;
    this.#player.active = null;
    effects.push({ kind: "piece-locked", eventId: lockEventId });

    if (completed.length > 0) {
      this.#resolution = {
        kind: "line-clear",
        remainingTicks: RULES.timing.lineClearTicks,
        totalTicks: RULES.timing.lineClearTicks,
        rows: [...completed],
        lockEventId,
        lockLevel: this.#level,
        active: cloneActivePiece(active),
        clearKind,
        captured: captured.map((trigger) => ({ ...trigger })),
      };
      effects.push({
        kind: "line-clear",
        phase: "anticipation",
        rows: completed.length,
        cells: completed.flatMap((y) =>
          Array.from({ length: RULES.board.width }, (_, x) => ({ x, y })),
        ),
      });
      return effects;
    }

    effects.push(
      ...this.#finishLock(active, lockEventId, this.#level, clearKind, captured),
    );
    return effects;
  }

  #finishLock(
    active: ActivePiece,
    lockEventId: string,
    lockLevel: number,
    clearKind: ClearKind,
    captured: readonly CapturedSpecial[],
  ): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    const completed = findCompleteLines(this.#player.grid);
    this.#lastTrace.push("remove-lines");
    this.#player.grid = clearLines(this.#player.grid, completed);

    this.#lastTrace.push("score-combo-b2b-attack-charge");
    const progress = resolveClearProgress({
      clearKind,
      clearedLineCount: completed.length,
      level: lockLevel,
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
    if (clearKind.startsWith("t-spin")) {
      effects.push({ kind: "t-spin" });
    }
    if (progress.lineCount > 0) {
      effects.push({
        kind: "line-clear",
        phase: "impact",
        rows: progress.lineCount,
        value: progress.score,
      });
    }
    if (progress.hollowCross !== null) {
      effects.push({
        kind: "hollow-cross",
        eventId: `${lockEventId}:cross`,
        crossVariant: progress.hollowCross,
      });
    }

    this.#lastTrace.push("resolve-specials");
    const specials = resolveSpecialTriggers(this.#player.grid, captured, this.#seed, lockEventId);
    this.#player.grid = specials.grid;
    specials.events.forEach((event) => {
      effects.push({
        kind: "special-trigger",
        eventId: event.eventId,
        special: event.kind,
        row: event.row,
        column: event.column,
        order: event.order,
        cells: event.affectedCells.map((cell) => ({ ...cell })),
      });
    });
    specials.blackoutEvents.forEach((eventId) => {
      this.#player.statuses = activateTimedStatus(this.#player.statuses, "blackout");
      effects.push({ kind: "blackout-start", eventId });
    });
    specials.barrierEvents.forEach((eventId) => {
      this.#player.statuses = activateBarrier(this.#player.statuses);
      effects.push({ kind: "barrier-start", eventId });
    });

    this.#lastTrace.push("cancel-incoming");
    const totalAttack = progress.attackRows + specials.garbageCoreEvents.length;
    const canceled = cancelIncomingGarbage(this.#player.incomingGarbage, totalAttack);
    this.#player.incomingGarbage = canceled.incoming;

    this.#lastTrace.push("emit-attacks");
    if (canceled.outgoingRows > 0) {
      effects.push({
        kind: "garbage-attack",
        rows: canceled.outgoingRows,
        eventId: `${lockEventId}:garbage`,
      });
    }
    this.#player.stats.garbageSent += canceled.outgoingRows;
    specials.glitchEvents.forEach((eventId) => {
      effects.push({ kind: "glitch-piece", eventId });
    });

    this.#lastTrace.push("activate-power");
    let activated: PowerKind | null = null;
    if (this.#player.powerCharge >= RULES.power.threshold) {
      activated = this.#player.upcomingPower;
      this.#player.powerCharge -= RULES.power.threshold;
      this.#player.powerDeckCursor += 1;
      this.#player.upcomingPower = this.#factory.powerAt(this.#player.powerDeckCursor);
    }
    this.#lastTrace.push("resolve-immediate-power");
    if (activated !== null) {
      effects.push(...this.#schedulePower(activated, true));
      return effects;
    }

    effects.push(...this.#finishAfterPower());
    return effects;
  }

  #finishAfterPower(): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
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
    this.#applyBufferedSpawnActions(effects);
    return effects;
  }

  #advanceResolution(): SimulationEffect[] {
    const resolution = this.#resolution;
    if (resolution === null) return [];
    if (resolution.kind === "acid-dissolve") {
      resolution.remainingTicks -= 1;
      resolution.ticksUntilNext -= 1;
      if (resolution.ticksUntilNext > 0) return [];
      const order = resolution.nextCellIndex;
      const cell = resolution.cells[order];
      const effects: SimulationEffect[] = [];
      if (cell !== undefined) {
        this.#player.grid[cell.y]![cell.x] = null;
        effects.push({
          kind: "acid-dissolve",
          eventId: `${resolution.eventId}:cell:${order + 1}`,
          phase: "dissolve",
          column: resolution.column,
          order,
          cells: [{ ...cell }],
        });
      }
      resolution.nextCellIndex += 1;
      if (resolution.nextCellIndex >= resolution.cells.length) {
        this.#resolution = null;
        effects.push(...this.#finishAcid());
      } else {
        resolution.ticksUntilNext = RULES.timing.acidDissolveStepTicks;
      }
      return effects;
    }
    resolution.remainingTicks -= 1;
    if (resolution.remainingTicks > 0) return [];
    this.#resolution = null;
    if (resolution.kind === "line-clear") {
      return this.#finishLock(
        resolution.active,
        resolution.lockEventId,
        resolution.lockLevel,
        resolution.clearKind,
        resolution.captured,
      );
    }
    if (resolution.kind === "collapse-drop") {
      if (resolution.rows.length > 0) {
        this.#resolution = {
          ...resolution,
          kind: "collapse-clear",
          remainingTicks: RULES.timing.lineClearTicks,
          totalTicks: RULES.timing.lineClearTicks,
        };
        return [
          {
            kind: "line-clear",
            phase: "anticipation",
            rows: resolution.rows.length,
            cells: resolution.rows.flatMap((y) =>
              Array.from({ length: RULES.board.width }, (_, x) => ({ x, y })),
            ),
          },
        ];
      }
      const effects: SimulationEffect[] = [
        {
          kind: "collapse",
          eventId: resolution.eventId,
          phase: "impact",
          value: 0,
        },
      ];
      if (resolution.spawnAfter) effects.push(...this.#finishAfterPower());
      return effects;
    }
    if (resolution.kind === "collapse-clear") {
      const result = completePreparedCollapse(
        this.#player.grid,
        resolution.rows,
        resolution.level,
      );
      this.#player.grid = result.grid;
      this.#player.score += result.score;
      this.#player.lines += result.clearedLines;
      const effects: SimulationEffect[] = [
        {
          kind: "line-clear",
          phase: "impact",
          rows: result.clearedLines,
          value: result.score,
        },
        {
          kind: "collapse",
          eventId: resolution.eventId,
          phase: "impact",
          value: result.clearedLines,
        },
      ];
      if (resolution.spawnAfter) effects.push(...this.#finishAfterPower());
      return effects;
    }
    const effects: SimulationEffect[] = [];
    this.#applyPowerImpact(resolution.power, resolution.eventId, effects);
    if (resolution.power === "collapse") {
      const prepared = prepareCollapse(this.#player.grid);
      this.#player.grid = prepared.grid;
      effects.push({
        kind: "collapse",
        eventId: resolution.eventId,
        phase: "drop",
        movements: prepared.movements.map((movement) => ({
          from: { ...movement.from },
          to: { ...movement.to },
        })),
      });
      this.#resolution = {
        kind: "collapse-drop",
        remainingTicks: RULES.timing.collapseDropTicks,
        totalTicks: RULES.timing.collapseDropTicks,
        rows: [...prepared.completedRows],
        eventId: resolution.eventId,
        spawnAfter: resolution.spawnAfter,
        level: this.#level,
      };
      return effects;
    }
    if (resolution.spawnAfter) effects.push(...this.#finishAfterPower());
    return effects;
  }

  #tickOne(): SimulationEffect[] {
    const effects: SimulationEffect[] = [];
    if (this.#paused || this.#player.topOut !== null) return effects;
    this.#tick += 1;
    this.#level = Math.floor(this.#tick / RULES.timing.levelTicks) + 1;
    if (this.#resolution !== null) return this.#advanceResolution();
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
    if (!collides(this.#player.grid, falling)) {
      this.#player.active = falling;
      if (active.descriptor.source === "acid" && isGrounded(this.#player.grid, falling)) {
        effects.push(...this.#resolveAcid());
      }
    }
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

  currentTick(): Tick {
    return this.#tick;
  }

  hasStatus(kind: StatusState["kind"]): boolean {
    return this.#player.statuses.some((status) => status.kind === kind);
  }

  checkpoint(): SimulationCheckpoint {
    return {
      tick: this.#tick,
      level: this.#level,
      player: clonePlayer(this.#player),
      gravityCountdown: this.#gravityCountdown,
      gravityStep: this.#gravityStep,
      eventOrdinal: this.#eventOrdinal,
      resolution: clonePendingResolution(this.#resolution),
      bufferedSpawnActions: { ...this.#bufferedSpawnActions },
    };
  }

  restore(checkpoint: SimulationCheckpoint): void {
    this.#tick = checkpoint.tick;
    this.#level = checkpoint.level;
    this.#player = clonePlayer(checkpoint.player);
    this.#gravityCountdown = checkpoint.gravityCountdown;
    this.#gravityStep = checkpoint.gravityStep;
    this.#eventOrdinal = checkpoint.eventOrdinal;
    this.#resolution = clonePendingResolution(checkpoint.resolution);
    this.#bufferedSpawnActions = { ...checkpoint.bufferedSpawnActions };
  }

  readSnapshot(): SimulationSnapshot {
    const player = clonePlayer(this.#player);
    const ghostJammed = player.statuses.some((status) => status.kind === "ghost-jam");
    const ghostY =
      ghostJammed || player.active === null || collides(player.grid, player.active)
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
      resolution: resolutionView(this.#resolution),
      stateHash: hashCanonical({
        tick: this.#tick,
        level: this.#level,
        player,
        gravityCountdown: this.#gravityCountdown,
        gravityStep: this.#gravityStep,
        eventOrdinal: this.#eventOrdinal,
        resolution: this.#resolution,
        bufferedSpawnActions: this.#bufferedSpawnActions,
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

  receiveHollowCross(
    eventId: string,
    crossVariant: HollowCrossVariant,
  ): void {
    const queued = enqueueHollowCross(this.#player.forcedQueue, crossVariant, eventId);
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

  receiveOversize(
    eventId: string,
    senderId?: string,
    sourceTick?: number,
  ): SimulationEffect[] {
    const shape = this.#factory.oversizeAt(this.#player.oversizePieceCursor);
    this.#player.oversizePieceCursor += 1;
    const queued = enqueueOversize(this.#player.forcedQueue, shape, eventId);
    this.#player.forcedQueue = queued.queue;
    if (queued.overflowGarbageRows > 0) {
      this.receiveGarbage(
        queued.overflowGarbageRows,
        `${eventId}:overflow`,
        senderId,
        sourceTick,
      );
      return [{
        kind: "oversize-overflow",
        eventId,
        rows: queued.overflowGarbageRows,
      }];
    }
    return [{ kind: "oversize-piece", eventId }];
  }

  receiveScramble(): void {
    this.#player.statuses = activateTimedStatus(this.#player.statuses, "scramble");
  }

  receiveGhostJam(): void {
    this.#player.statuses = activateTimedStatus(this.#player.statuses, "ghost-jam");
  }
}

export function createSimulation(options: SimulationOptions): Simulation {
  return new LocalSimulation(options);
}
