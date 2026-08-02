import { RULES } from "../config/rules";
import {
  createBasePieceSequence,
  createPowerDeckSequence,
  createSpecialSchedule,
  type DeterministicSequence,
  type SpecialSchedule,
} from "./bag";
import type {
  Cell,
  PieceDescriptor,
  PlayerGameState,
  PowerKind,
  StandardShape,
} from "./types";

export interface PieceFactory {
  baseAt(index: number): PieceDescriptor;
  powerAt(index: number): PowerKind;
}

class SeededPieceFactory implements PieceFactory {
  readonly #base: DeterministicSequence<StandardShape>;
  readonly #powers: DeterministicSequence<PowerKind>;
  readonly #specials: SpecialSchedule;

  constructor(seed: string) {
    this.#base = createBasePieceSequence(seed);
    this.#powers = createPowerDeckSequence(seed);
    this.#specials = createSpecialSchedule(seed);
  }

  baseAt(index: number): PieceDescriptor {
    const marker = this.#specials.at(index);
    const descriptor: PieceDescriptor = { source: "base", shape: this.#base.at(index) };
    if (marker !== null) {
      descriptor.specialCellIndex = marker.cellIndex;
      descriptor.specialKind = marker.kind;
    }
    return descriptor;
  }

  powerAt(index: number): PowerKind {
    return this.#powers.at(index);
  }
}

export function createPieceFactory(seed: string): PieceFactory {
  return new SeededPieceFactory(seed);
}

export function createPlayerState(playerId: string, seed: string): PlayerGameState {
  const factory = createPieceFactory(seed);
  return {
    playerId,
    grid: Array.from({ length: RULES.board.height }, () =>
      Array.from({ length: RULES.board.width }, (): Cell | null => null),
    ),
    active: null,
    hold: null,
    holdUsed: false,
    basePieceCursor: 0,
    forcedQueue: [],
    pendingReplacementModes: [],
    replacementMode: null,
    score: 0,
    lines: 0,
    comboIndex: -1,
    backToBack: false,
    powerCharge: 0,
    powerDeckCursor: 0,
    upcomingPower: factory.powerAt(0),
    statuses: [],
    incomingGarbage: [],
    lastGarbageHole: null,
    specialSchedule: { standardCursor: 0, ordinalCycle: 0, typeCursor: 0 },
    stats: {
      garbageSent: 0,
      powersActivated: 0,
      tetrises: 0,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    },
    topOut: null,
  };
}

function copyForQueueChange(state: PlayerGameState): PlayerGameState {
  return {
    ...state,
    forcedQueue: [...state.forcedQueue],
    pendingReplacementModes: [...state.pendingReplacementModes],
    replacementMode: state.replacementMode === null ? null : { ...state.replacementMode },
  };
}

function descriptorForMode(
  mode: NonNullable<PlayerGameState["replacementMode"]>,
): PieceDescriptor {
  return mode.kind === "monomino-rush"
    ? { source: "monomino", shape: "monomino" }
    : { source: "acid", shape: "acid" };
}

export interface SpawnSelection {
  state: PlayerGameState;
  descriptor: PieceDescriptor;
}

export function selectSpawnDescriptor(
  source: PlayerGameState,
  factory: PieceFactory,
): SpawnSelection {
  const state = copyForQueueChange(source);

  if (state.replacementMode !== null) {
    return { state, descriptor: descriptorForMode(state.replacementMode) };
  }

  const forced = state.forcedQueue.shift();
  if (forced !== undefined) return { state, descriptor: forced };

  const pendingMode = state.pendingReplacementModes.shift();
  if (pendingMode !== undefined) {
    state.replacementMode =
      pendingMode === "monomino-rush"
        ? { kind: "monomino-rush", remainingTicks: RULES.power.monominoRushTicks }
        : { kind: "acid-rain", remainingPieces: RULES.power.acidRainPieces };
    return { state, descriptor: descriptorForMode(state.replacementMode) };
  }

  const descriptor = factory.baseAt(state.basePieceCursor);
  state.basePieceCursor += 1;
  state.specialSchedule.standardCursor = state.basePieceCursor;
  return { state, descriptor };
}

export function completeReplacementPiece(source: PlayerGameState): PlayerGameState {
  const state = copyForQueueChange(source);
  if (state.replacementMode?.kind === "acid-rain") {
    const remaining = Math.max(0, (state.replacementMode.remainingPieces ?? 0) - 1);
    state.replacementMode =
      remaining === 0 ? null : { kind: "acid-rain", remainingPieces: remaining };
  } else if (
    state.replacementMode?.kind === "monomino-rush" &&
    state.replacementMode.expiresAfterCurrent === true
  ) {
    state.replacementMode = null;
  }
  return state;
}

export function advanceReplacementClock(
  source: PlayerGameState,
  ticks = 1,
): PlayerGameState {
  const state = copyForQueueChange(source);
  if (state.replacementMode?.kind !== "monomino-rush") return state;
  const remaining = Math.max(0, (state.replacementMode.remainingTicks ?? 0) - ticks);
  state.replacementMode = {
    kind: "monomino-rush",
    remainingTicks: remaining,
    ...(remaining === 0 ? { expiresAfterCurrent: true } : {}),
  };
  return state;
}
