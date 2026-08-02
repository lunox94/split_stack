import { RULES } from "../config/rules";
import { STANDARD_SHAPES } from "../config/rules";
import type {
  ActivePiece,
  Cell,
  CellKind,
  GarbagePacket,
  Grid,
  PieceDescriptor,
  PlayerGameState,
  PlayerId,
  PlayerLiveStats,
  PowerKind,
  ReplacementMode,
  SpecialScheduleState,
  SpecialKind,
  StatusState,
  Tick,
} from "../domain/types";
import type { RealtimeEnvelope, SessionId, StreamCursor } from "./messages";

export interface PlayerSnapshotV1 {
  schema: "split-stack/snapshot/v1";
  snapshotSeq: number;
  stateTick: Tick;
  playerId: PlayerId;
  grid: number[];
  active: ActivePiece | null;
  ghostRow: number | null;
  hold: PieceDescriptor | null;
  nextFive: PieceDescriptor[];
  basePieceCursor: number;
  forcedQueue: PieceDescriptor[];
  score: number;
  level: number;
  lines: number;
  comboIndex: number;
  backToBack: boolean;
  powerCharge: number;
  powerDeckCursor: number;
  upcomingPower: PowerKind;
  statuses: StatusState[];
  incomingGarbage: GarbagePacket[];
  holdUsed: boolean;
  pendingReplacementModes: Array<"monomino-rush" | "acid-rain">;
  replacementMode: ReplacementMode | null;
  lastGarbageHole: number | null;
  specialSchedule: SpecialScheduleState;
  stats: PlayerLiveStats;
  topOut: { tick: Tick; reason: "spawn" | "garbage" } | null;
  lastAppliedCritical: StreamCursor[];
  stateHash: number;
}

export interface CreatePlayerSnapshotInput {
  player: PlayerGameState;
  stateTick: Tick;
  snapshotSeq: number;
  level: number;
  ghostRow: number | null;
  nextFive: readonly PieceDescriptor[];
  lastAppliedCritical: readonly StreamCursor[];
  stateHash: number;
}

const CELL_KINDS: readonly CellKind[] = [
  "I",
  "J",
  "L",
  "O",
  "S",
  "T",
  "Z",
  "cross",
  "monomino",
  "garbage",
];
const SPECIAL_KINDS: readonly SpecialKind[] = [
  "column-bomb",
  "garbage-core",
  "glitch-core",
];

function cellCode(cell: Cell | null): number {
  if (cell === null) return 0;
  const kindIndex = CELL_KINDS.indexOf(cell.kind);
  if (kindIndex < 0) throw new RangeError("Unknown snapshot cell kind");
  const specialIndex = cell.special === undefined ? -1 : SPECIAL_KINDS.indexOf(cell.special);
  if (cell.special !== undefined && specialIndex < 0) {
    throw new RangeError("Unknown snapshot special kind");
  }
  return kindIndex + 1 + (specialIndex + 1) * 16;
}

function decodeCell(code: number): Cell | null {
  if (!Number.isSafeInteger(code) || code < 0 || code > 63) {
    throw new RangeError("Invalid snapshot cell code");
  }
  if (code === 0) return null;
  const kindIndex = (code & 0x0f) - 1;
  const specialCode = code >> 4;
  const kind = CELL_KINDS[kindIndex];
  if (kind === undefined || specialCode > SPECIAL_KINDS.length) {
    throw new RangeError("Invalid snapshot cell code");
  }
  if (specialCode === 0) return { kind };
  const special = SPECIAL_KINDS[specialCode - 1];
  if (special === undefined) throw new RangeError("Invalid snapshot special code");
  return { kind, special };
}

export function encodeGrid(grid: Grid): number[] {
  if (grid.length !== RULES.board.height) {
    throw new RangeError("Snapshot grid has the wrong height");
  }
  const encoded: number[] = [];
  for (const row of grid) {
    if (row.length !== RULES.board.width) {
      throw new RangeError("Snapshot grid has the wrong width");
    }
    for (const cell of row) encoded.push(cellCode(cell));
  }
  return encoded;
}

export function decodeGrid(encoded: readonly number[]): Grid {
  if (encoded.length !== RULES.board.width * RULES.board.height) {
    throw new RangeError("Compact snapshot grid has the wrong size");
  }
  const grid: Grid = [];
  for (let row = 0; row < RULES.board.height; row += 1) {
    const decodedRow: Grid[number] = [];
    for (let column = 0; column < RULES.board.width; column += 1) {
      const code = encoded[row * RULES.board.width + column];
      if (code === undefined) throw new RangeError("Compact snapshot grid is incomplete");
      decodedRow.push(decodeCell(code));
    }
    grid.push(decodedRow);
  }
  return grid;
}

export function createPlayerSnapshot(input: CreatePlayerSnapshotInput): PlayerSnapshotV1 {
  const { player } = input;
  return {
    schema: "split-stack/snapshot/v1",
    snapshotSeq: input.snapshotSeq,
    stateTick: input.stateTick,
    playerId: player.playerId,
    grid: encodeGrid(player.grid),
    active:
      player.active === null
        ? null
        : { ...player.active, descriptor: { ...player.active.descriptor } },
    ghostRow: input.ghostRow,
    hold: player.hold === null ? null : { ...player.hold },
    nextFive: input.nextFive.map((piece) => ({ ...piece })),
    basePieceCursor: player.basePieceCursor,
    forcedQueue: player.forcedQueue.map((piece) => ({ ...piece })),
    score: player.score,
    level: input.level,
    lines: player.lines,
    comboIndex: player.comboIndex,
    backToBack: player.backToBack,
    powerCharge: player.powerCharge,
    powerDeckCursor: player.powerDeckCursor,
    upcomingPower: player.upcomingPower,
    statuses: player.statuses.map((status) => ({ ...status })),
    incomingGarbage: player.incomingGarbage.map((packet) => ({ ...packet })),
    holdUsed: player.holdUsed,
    pendingReplacementModes: [...player.pendingReplacementModes],
    replacementMode:
      player.replacementMode === null ? null : { ...player.replacementMode },
    lastGarbageHole: player.lastGarbageHole,
    specialSchedule: { ...player.specialSchedule },
    stats: { ...player.stats },
    topOut: player.topOut === null ? null : { ...player.topOut },
    lastAppliedCritical: input.lastAppliedCritical.map((cursor) => ({
      stream: { ...cursor.stream },
      contiguousThrough: cursor.contiguousThrough,
    })),
    stateHash: input.stateHash,
  };
}

function cloneSnapshot(snapshot: PlayerSnapshotV1): PlayerSnapshotV1 {
  return {
    ...snapshot,
    grid: [...snapshot.grid],
    active:
      snapshot.active === null
        ? null
        : { ...snapshot.active, descriptor: { ...snapshot.active.descriptor } },
    hold: snapshot.hold === null ? null : { ...snapshot.hold },
    nextFive: snapshot.nextFive.map((piece) => ({ ...piece })),
    forcedQueue: snapshot.forcedQueue.map((piece) => ({ ...piece })),
    statuses: snapshot.statuses.map((status) => ({ ...status })),
    incomingGarbage: snapshot.incomingGarbage.map((packet) => ({ ...packet })),
    pendingReplacementModes: [...snapshot.pendingReplacementModes],
    replacementMode:
      snapshot.replacementMode === null ? null : { ...snapshot.replacementMode },
    specialSchedule: { ...snapshot.specialSchedule },
    stats: { ...snapshot.stats },
    topOut: snapshot.topOut === null ? null : { ...snapshot.topOut },
    lastAppliedCritical: snapshot.lastAppliedCritical.map((cursor) => ({
      stream: { ...cursor.stream },
      contiguousThrough: cursor.contiguousThrough,
    })),
  };
}

function isCounter(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= 0x7fff_ffff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShortId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isPieceDescriptor(value: unknown): value is PieceDescriptor {
  if (!isRecord(value)) return false;
  const source = value.source;
  const shape = value.shape;
  const hasSpecialIndex = value.specialCellIndex !== undefined;
  const hasSpecialKind = value.specialKind !== undefined;
  const standard = ["I", "J", "L", "O", "S", "T", "Z"].includes(String(shape));
  const compatible =
    ((source === "base" || source === "glitch") && standard) ||
    (source === "cross" && shape === "cross") ||
    (source === "monomino" && shape === "monomino") ||
    (source === "acid" && shape === "acid");
  const cosmetics = value.previewCosmetics;
  const cosmeticsValid =
    cosmetics === undefined ||
    (source === "glitch" &&
      isRecord(cosmetics) &&
      cosmetics.kind === "glitch-cycle" &&
      Array.isArray(cosmetics.shapes) &&
      cosmetics.shapes.length === STANDARD_SHAPES.length &&
      cosmetics.shapes.every((item, index) => item === STANDARD_SHAPES[index]) &&
      cosmetics.intervalMs === RULES.special.glitchCycleMs &&
      cosmetics.finalShapeConcealed === true);
  return (
    compatible &&
    cosmeticsValid &&
    hasSpecialIndex === hasSpecialKind &&
    (!hasSpecialIndex ||
      (source === "base" &&
        Number.isSafeInteger(value.specialCellIndex) &&
        (value.specialCellIndex as number) >= 0 &&
        (value.specialCellIndex as number) < 4 &&
        SPECIAL_KINDS.includes(value.specialKind as SpecialKind))) &&
    (value.eventId === undefined || isShortId(value.eventId))
  );
}

function isActivePiece(value: unknown): value is ActivePiece {
  if (value === null) return true;
  if (!isRecord(value) || !isPieceDescriptor(value.descriptor)) return false;
  return (
    Number.isSafeInteger(value.x) &&
    (value.x as number) >= -10 &&
    (value.x as number) <= RULES.board.width + 10 &&
    Number.isSafeInteger(value.y) &&
    (value.y as number) >= -10 &&
    (value.y as number) <= RULES.board.height &&
    [0, 1, 2, 3].includes(value.rotation as number) &&
    Number.isSafeInteger(value.lockTicksRemaining) &&
    (value.lockTicksRemaining as number) >= 0 &&
    (value.lockTicksRemaining as number) <= RULES.timing.lockDelayTicks &&
    Number.isSafeInteger(value.lockResetCount) &&
    (value.lockResetCount as number) >= 0 &&
    (value.lockResetCount as number) <= RULES.timing.lockResetCap &&
    (value.lastSuccessfulAction === undefined ||
      ["move", "rotate-cw", "rotate-ccw", "soft-drop", "hard-drop"].includes(
        String(value.lastSuccessfulAction),
      ))
  );
}

function isStatus(value: unknown): boolean {
  if (!isRecord(value) || !isCounter(value.remainingTicks as number)) return false;
  if (value.kind === "blackout" || value.kind === "scramble") return true;
  return (
    value.kind === "barrier" &&
    Number.isSafeInteger(value.capacity) &&
    (value.capacity as number) >= 0 &&
    (value.capacity as number) <= RULES.garbage.barrierCapacity
  );
}

function isGarbagePacket(value: unknown): boolean {
  return (
    isRecord(value) &&
    isShortId(value.id) &&
    Number.isSafeInteger(value.rows) &&
    (value.rows as number) > 0 &&
    (value.rows as number) <= 256 &&
    isCounter(value.readyTick as number) &&
    Number.isSafeInteger(value.hole) &&
    (value.hole as number) >= 0 &&
    (value.hole as number) < RULES.board.width &&
    (value.senderId === undefined || isShortId(value.senderId))
  );
}

function isReplacementMode(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !["monomino-rush", "acid-rain"].includes(String(value.kind))) {
    return false;
  }
  return (
    (value.remainingTicks === undefined || isCounter(value.remainingTicks as number)) &&
    (value.remainingPieces === undefined || isCounter(value.remainingPieces as number)) &&
    (value.expiresAfterCurrent === undefined ||
      typeof value.expiresAfterCurrent === "boolean")
  );
}

function isSpecialSchedule(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCounter(value.standardCursor as number) &&
    isCounter(value.ordinalCycle as number) &&
    isCounter(value.typeCursor as number)
  );
}

function isStats(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    [
      "garbageSent",
      "powersActivated",
      "tetrises",
      "tSpinSingles",
      "tSpinDoubles",
      "tSpinTriples",
    ].every((field) => isCounter(value[field] as number)) &&
    (value.topOutTick === undefined || isCounter(value.topOutTick as number))
  );
}

function isTopOut(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      isCounter(value.tick as number) &&
      (value.reason === "spawn" || value.reason === "garbage"))
  );
}

function isStreamCursor(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.stream) &&
    isShortId(value.stream.senderId) &&
    isShortId(value.stream.sessionId) &&
    isCounter(value.contiguousThrough as number)
  );
}

export function isPlayerSnapshot(value: unknown): value is PlayerSnapshotV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PlayerSnapshotV1>;
  if (
    candidate.schema !== "split-stack/snapshot/v1" ||
    typeof candidate.playerId !== "string" ||
    candidate.playerId.length === 0 ||
    candidate.playerId.length > 256 ||
    candidate.grid === undefined ||
    !Array.isArray(candidate.grid) ||
    candidate.grid.length !== RULES.board.width * RULES.board.height ||
    !candidate.grid.every((code) => {
      try {
        decodeCell(code);
        return true;
      } catch {
        return false;
      }
    }) ||
    !isCounter(candidate.snapshotSeq ?? -1) ||
    !isCounter(candidate.stateTick ?? -1) ||
    !isCounter(candidate.basePieceCursor ?? -1) ||
    !isCounter(candidate.score ?? -1) ||
    !isCounter(candidate.level ?? -1, 1) ||
    !isCounter(candidate.lines ?? -1) ||
    !Number.isSafeInteger(candidate.comboIndex) ||
    (candidate.comboIndex ?? -2) < -1 ||
    typeof candidate.backToBack !== "boolean" ||
    !isCounter(candidate.powerCharge ?? -1) ||
    candidate.powerCharge! > RULES.power.threshold ||
    !isCounter(candidate.powerDeckCursor ?? -1) ||
    !Number.isSafeInteger(candidate.stateHash) ||
    (candidate.stateHash ?? -1) < 0 ||
    candidate.stateHash! > 0xffff_ffff ||
    !RULES.power.deck.includes(candidate.upcomingPower as PowerKind) ||
    !isActivePiece(candidate.active) ||
    !(
      candidate.ghostRow === null ||
      (Number.isSafeInteger(candidate.ghostRow) &&
        candidate.ghostRow! >= 0 &&
        candidate.ghostRow! < RULES.board.height)
    ) ||
    !(candidate.hold === null || isPieceDescriptor(candidate.hold)) ||
    !Array.isArray(candidate.nextFive) ||
    candidate.nextFive.length > 5 ||
    !candidate.nextFive.every(isPieceDescriptor) ||
    !Array.isArray(candidate.forcedQueue) ||
    candidate.forcedQueue.length > RULES.network.maxPendingCritical ||
    !candidate.forcedQueue.every(isPieceDescriptor) ||
    !Array.isArray(candidate.statuses) ||
    candidate.statuses.length > 8 ||
    !candidate.statuses.every(isStatus) ||
    !Array.isArray(candidate.incomingGarbage) ||
    candidate.incomingGarbage.length > RULES.network.maxPendingCritical ||
    !candidate.incomingGarbage.every(isGarbagePacket) ||
    typeof candidate.holdUsed !== "boolean" ||
    !Array.isArray(candidate.pendingReplacementModes) ||
    candidate.pendingReplacementModes.length > RULES.power.replacementQueueCap ||
    !candidate.pendingReplacementModes.every((mode) =>
      ["monomino-rush", "acid-rain"].includes(String(mode)),
    ) ||
    !isReplacementMode(candidate.replacementMode) ||
    !(
      candidate.lastGarbageHole === null ||
      (Number.isSafeInteger(candidate.lastGarbageHole) &&
        candidate.lastGarbageHole! >= 0 &&
        candidate.lastGarbageHole! < RULES.board.width)
    ) ||
    !isSpecialSchedule(candidate.specialSchedule) ||
    !isStats(candidate.stats) ||
    !isTopOut(candidate.topOut) ||
    !Array.isArray(candidate.lastAppliedCritical) ||
    candidate.lastAppliedCritical.length > 16 ||
    !candidate.lastAppliedCritical.every(isStreamCursor)
  ) {
    return false;
  }
  return true;
}

export class SnapshotScheduler {
  private lastPublishedTick: Tick | null = null;

  public constructor(private readonly intervalTicks = RULES.network.snapshotTicks) {
    if (!Number.isSafeInteger(intervalTicks) || intervalTicks <= 0) {
      throw new RangeError("Snapshot interval must be a positive integer");
    }
  }

  public claim(tick: Tick, simulationActive: boolean): boolean {
    if (!simulationActive || !Number.isSafeInteger(tick) || tick < 0) return false;
    if (tick % this.intervalTicks !== 0 || tick === this.lastPublishedTick) return false;
    this.lastPublishedTick = tick;
    return true;
  }

  public reset(): void {
    this.lastPublishedTick = null;
  }
}

/**
 * Realtime channels are broadcast and expose no authenticated sender metadata.
 * Callers must derive bindings from the durable seat log and explicitly bind the
 * one accepted runtime session before snapshots can affect the remote view.
 */
export class RemoteSnapshotStore {
  private readonly boundSessions = new Map<PlayerId, SessionId>();
  private readonly snapshots = new Map<PlayerId, PlayerSnapshotV1>();

  public bind(playerId: PlayerId, sessionId: SessionId): void {
    const previousSession = this.boundSessions.get(playerId);
    if (previousSession === sessionId) return;
    this.boundSessions.set(playerId, sessionId);
    this.snapshots.delete(playerId);
  }

  public accept(envelope: RealtimeEnvelope<"SNAPSHOT">): boolean {
    const boundSession = this.boundSessions.get(envelope.senderId);
    if (
      boundSession === undefined ||
      boundSession !== envelope.sessionId ||
      !isPlayerSnapshot(envelope.payload) ||
      envelope.payload.playerId !== envelope.senderId ||
      envelope.payload.stateTick !== envelope.matchTick
    ) {
      return false;
    }
    const current = this.snapshots.get(envelope.senderId);
    if (current !== undefined && envelope.payload.snapshotSeq <= current.snapshotSeq) {
      return false;
    }
    this.snapshots.set(envelope.senderId, cloneSnapshot(envelope.payload));
    return true;
  }

  public latest(playerId: PlayerId): PlayerSnapshotV1 | undefined {
    const snapshot = this.snapshots.get(playerId);
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
  }
}
