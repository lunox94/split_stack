export type PlayerId = string;
export type Tick = number;
export type Rotation = 0 | 1 | 2 | 3;
export type StandardShape = "I" | "J" | "L" | "O" | "S" | "T" | "Z";
export type OversizeShape = Exclude<StandardShape, "O">;
export type CellKind = StandardShape | "cross" | "monomino" | "garbage";
export type FallingShape = StandardShape | "cross" | "monomino" | "acid";
export type SpecialKind =
  | "column-bomb"
  | "garbage-core"
  | "glitch-core"
  | "blackout"
  | "barrier";
export type PowerKind =
  | "scramble"
  | "nuke"
  | "collapse"
  | "monomino-rush"
  | "acid-rain"
  | "oversize"
  | "ghost-jam";

export type PieceSource =
  | "base"
  | "cross"
  | "glitch"
  | "oversize"
  | "monomino"
  | "acid";

export interface Cell {
  kind: CellKind;
  special?: SpecialKind;
}

export type Grid = Array<Array<Cell | null>>;

export interface Coordinate {
  readonly x: number;
  readonly y: number;
}

export interface GlitchPreviewCosmetics {
  kind: "glitch-cycle";
  shapes: readonly StandardShape[];
  intervalMs: number;
  finalShapeConcealed: true;
}

export interface PieceDescriptor {
  source: PieceSource;
  shape: FallingShape;
  specialCellIndex?: number;
  specialKind?: SpecialKind;
  eventId?: string;
  previewCosmetics?: GlitchPreviewCosmetics;
}

export type SuccessfulAction =
  | "move"
  | "rotate-cw"
  | "rotate-ccw"
  | "soft-drop"
  | "hard-drop";

export interface ActivePiece {
  descriptor: PieceDescriptor;
  x: number;
  y: number;
  rotation: Rotation;
  lockTicksRemaining: number;
  lockResetCount: number;
  lastSuccessfulAction?: SuccessfulAction;
}

export type LogicalAction =
  | "move-left"
  | "move-right"
  | "soft-drop"
  | "hard-drop"
  | "rotate-cw"
  | "rotate-ccw"
  | "hold";

export interface GarbagePacket {
  id: string;
  rows: number;
  readyTick: Tick;
  hole: number;
  senderId?: PlayerId;
}

export interface TimedStatus {
  kind: "blackout" | "scramble" | "ghost-jam";
  remainingTicks: number;
}

export interface BarrierStatus {
  kind: "barrier";
  remainingTicks: number;
  capacity: number;
}

export type StatusState = TimedStatus | BarrierStatus;

export interface ReplacementMode {
  kind: "monomino-rush" | "acid-rain";
  remainingTicks?: number;
  remainingPieces?: number;
  expiresAfterCurrent?: boolean;
}

export interface PlayerLiveStats {
  garbageSent: number;
  powersActivated: number;
  tetrises: number;
  tSpinSingles: number;
  tSpinDoubles: number;
  tSpinTriples: number;
  topOutTick?: Tick;
}

export interface SpecialScheduleState {
  standardCursor: number;
  ordinalCycle: number;
  typeCursor: number;
}

export interface PlayerGameState {
  playerId: PlayerId;
  grid: Grid;
  active: ActivePiece | null;
  hold: PieceDescriptor | null;
  holdUsed: boolean;
  basePieceCursor: number;
  forcedQueue: PieceDescriptor[];
  pendingReplacementModes: Array<"monomino-rush" | "acid-rain">;
  replacementMode: ReplacementMode | null;
  score: number;
  lines: number;
  comboIndex: number;
  backToBack: boolean;
  powerCharge: number;
  powerDeckCursor: number;
  upcomingPower: PowerKind;
  oversizePieceCursor: number;
  statuses: StatusState[];
  incomingGarbage: GarbagePacket[];
  lastGarbageHole: number | null;
  specialSchedule: SpecialScheduleState;
  stats: PlayerLiveStats;
  topOut: { tick: Tick; reason: "spawn" | "garbage" } | null;
}

export type MatchPhase =
  | "lobby"
  | "countdown"
  | "playing"
  | "practice-paused"
  | "network-pause"
  | "finished";

export interface MatchState {
  rulesVersion: 2;
  matchId: string;
  seed: string;
  tick: Tick;
  level: number;
  phase: MatchPhase;
  localPlayerId: PlayerId;
  players: Record<PlayerId, PlayerGameState>;
  practice: boolean;
  result?: MatchResult;
}

export interface PlayerResultStats extends PlayerLiveStats {
  score: number;
  lines: number;
}

export interface MatchResult {
  schema: "split-stack/result/v1";
  matchId: string;
  seedHash: string;
  players: Array<{ id: string; displayName: string }>;
  outcome: "seat-a" | "seat-b" | "draw" | "desync";
  reason:
    | "top-out"
    | "forfeit"
    | "simultaneous"
    | "desynchronization"
    | "connection-lost";
  durationTicks: number;
  finalLevel: number;
  statsByPlayer: Record<string, PlayerResultStats>;
  completedBy: string;
}

export type ClearKind =
  | "none"
  | "single"
  | "double"
  | "triple"
  | "tetris"
  | "t-spin-none"
  | "t-spin-single"
  | "t-spin-double"
  | "t-spin-triple";

export interface LockResolution {
  clearKind: ClearKind;
  clearedLines: number[];
  scoreAwarded: number;
  attackRows: number;
  chargeAwarded: number;
  specialTriggers: Array<{ kind: SpecialKind; row: number; column: number }>;
  emittedForcedPieces: PieceDescriptor[];
  activatedPower: PowerKind | null;
  topOut: boolean;
}
