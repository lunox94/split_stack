import type { SpecialKind } from "../domain/types";
import type { CollapseMovement } from "../domain/powers";
import {
  DEFAULT_GARBAGE_CADENCE,
  garbageTimingFor,
  planGarbageSequence,
  type GarbageCadence,
  type GarbageScheduleResult,
} from "../app/garbage-sequence";

export type PresentationBoard = "left" | "right";
export type PresentationStage = "anticipation" | "action" | "follow-through";
export type PresentationMoment =
  | "compress"
  | "charge"
  | "travel"
  | "reticle"
  | "shockwave"
  | "splash"
  | "dissolve"
  | "pressure"
  | "lift"
  | "fall"
  | "rail"
  | "veil"
  | "glitch"
  | "ghost-flicker"
  | "ghost-dissolve"
  | "fracture"
  | "special-burst"
  | "impact"
  | "particles";

export interface LineClearCue {
  readonly id: string;
  readonly kind: "line-clear";
  readonly board: PresentationBoard;
  readonly rows: readonly number[];
}

export type OffensiveAttack =
  | "garbage"
  | "blackout"
  | "scramble"
  | "hollow-cross"
  | "glitch"
  | "oversize"
  | "ghost-jam";

export interface OffensiveTransferCue {
  readonly id: string;
  readonly kind: "offensive-transfer";
  readonly attack: OffensiveAttack;
  readonly source: PresentationBoard;
  readonly target: PresentationBoard;
}

export interface GridPoint {
  readonly column: number;
  readonly row: number;
}

export interface NukeCue {
  readonly id: string;
  readonly kind: "nuke";
  readonly board: PresentationBoard;
  readonly center: GridPoint;
}

export interface AcidDissolveCue {
  readonly id: string;
  readonly kind: "acid-dissolve";
  readonly board: PresentationBoard;
  readonly column: number;
  readonly occupiedRows: readonly number[];
}

export interface GarbageRiseCue {
  readonly id: string;
  readonly kind: "garbage-rise";
  readonly board: PresentationBoard;
  readonly rowCount: number;
}

export interface CollapseCue {
  readonly id: string;
  readonly kind: "collapse";
  readonly board: PresentationBoard;
  readonly completedRows: readonly number[];
  readonly movements: readonly CollapseMovement[];
}

export interface BarrierCue {
  readonly id: string;
  readonly kind: "barrier";
  readonly board: PresentationBoard;
  readonly capacity: number;
}

export interface BarrierHitCue {
  readonly id: string;
  readonly kind: "barrier-hit";
  readonly board: PresentationBoard;
}

export interface StatusPowerCue {
  readonly id: string;
  readonly kind:
    | "blackout"
    | "scramble"
    | "monomino-rush"
    | "acid-rain";
  readonly board: PresentationBoard;
}

export interface GhostJamCue {
  readonly id: string;
  readonly kind: "ghost-jam";
  readonly board: PresentationBoard;
  readonly ghostCells: readonly GridPoint[];
}

export interface SpecialTriggerPoint {
  readonly special: SpecialKind;
  readonly row: number;
  readonly column: number;
}

export interface SpecialChainCue {
  readonly id: string;
  readonly kind: "special-chain";
  readonly board: PresentationBoard;
  readonly triggers: readonly SpecialTriggerPoint[];
}

export type PresentationCue =
  | LineClearCue
  | OffensiveTransferCue
  | NukeCue
  | AcidDissolveCue
  | GarbageRiseCue
  | CollapseCue
  | BarrierCue
  | BarrierHitCue
  | StatusPowerCue
  | GhostJamCue
  | SpecialChainCue;

export interface PresentationTiming {
  readonly impactAtMs: number;
  readonly blockingUntilMs: number;
  readonly durationMs: number;
}

export interface PresentationOptions {
  readonly reducedMotion?: boolean;
  readonly reducedFlashes?: boolean;
  readonly screenShake?: boolean;
  readonly particleScale?: number;
}

export interface PresentationEffect {
  readonly id: string;
  readonly kind: PresentationCue["kind"];
  readonly board: PresentationBoard;
  readonly stage: PresentationStage;
  readonly moment: PresentationMoment;
  readonly progress: number;
  readonly stageProgress: number;
  readonly rows?: readonly number[];
  readonly source?: PresentationBoard;
  readonly target?: PresentationBoard;
  readonly attack?: OffensiveAttack;
  readonly center?: GridPoint;
  readonly footprint?: { readonly width: 5; readonly height: 5 };
  readonly column?: number;
  readonly resolvedRows?: readonly number[];
  readonly rowCount?: number;
  /** Cumulative number of cell rows already lifted, including the active fraction. */
  readonly garbageLiftRows?: number;
  /** Zero-based row beat most recently started by a garbage-rise sequence. */
  readonly garbageActiveRow?: number;
  /** Progress of the active garbage row's lift. */
  readonly garbageRowProgress?: number;
  /** Number of garbage rows whose lift has fully seated. */
  readonly garbageSettledRows?: number;
  /** Total admitted rows still contributing to the board's shared lift offset. */
  readonly garbageStackRows?: number;
  /** Cumulative shared lift across active, queued, and just-completed batches. */
  readonly garbageStackLiftRows?: number;
  /** Short highlight envelope fired as each row seats. */
  readonly garbageSeatPulse?: number;
  readonly completedRows?: readonly number[];
  readonly movements?: readonly CollapseMovement[];
  readonly capacity?: number;
  readonly ghostCells?: readonly GridPoint[];
  readonly visualStyle: "motion" | "fade";
  readonly particleCount: number;
  readonly flash: boolean;
  readonly resolvedSpecials?: readonly SpecialTriggerPoint[];
}

export interface PresentationShake {
  readonly x: number;
  readonly y: number;
  readonly magnitude: number;
}

export interface PresentationFrame {
  readonly atMs: number;
  readonly blocking: boolean;
  readonly effects: readonly PresentationEffect[];
  readonly shake: PresentationShake | null;
}

interface ScheduledCue {
  readonly cue: PresentationCue;
  readonly startedAtMs: number;
  readonly timing: PresentationTiming;
  readonly garbageCadence?: GarbageCadence;
  readonly requestedAtMs?: number;
}

const MAX_SCHEDULED_CUES = 64;

const LINE_CLEAR_TIMING: PresentationTiming = {
  impactAtMs: 120,
  blockingUntilMs: 150,
  durationMs: 360,
};

const OFFENSIVE_TRANSFER_TIMING: PresentationTiming = {
  impactAtMs: 200,
  blockingUntilMs: 230,
  durationMs: 430,
};

const NUKE_TIMING: PresentationTiming = {
  impactAtMs: 200,
  blockingUntilMs: 230,
  durationMs: 650,
};

const COLLAPSE_TIMING: PresentationTiming = {
  impactAtMs: 200,
  blockingUntilMs: 450,
  durationMs: 610,
};

const STATUS_POWER_TIMING: PresentationTiming = {
  impactAtMs: 200,
  blockingUntilMs: 230,
  durationMs: 500,
};

const BARRIER_HIT_TIMING: PresentationTiming = {
  impactAtMs: 0,
  blockingUntilMs: 0,
  durationMs: 220,
};

const SPECIAL_STEP_MS = 55;

const orderedSpecials = (cue: SpecialChainCue): SpecialTriggerPoint[] =>
  [...cue.triggers].sort(
    (left, right) => right.row - left.row || left.column - right.column,
  );

const acidRows = (cue: AcidDissolveCue): number[] =>
  [...new Set(cue.occupiedRows)].sort((left, right) => left - right);

const acidStepMs = (cue: AcidDissolveCue): number =>
  Math.min(35, 310 / Math.max(1, acidRows(cue).length));

const timingFor = (
  cue: PresentationCue,
  garbageCadence = DEFAULT_GARBAGE_CADENCE,
): PresentationTiming => {
  if (cue.kind === "barrier-hit") return BARRIER_HIT_TIMING;
  if (cue.kind === "line-clear") return LINE_CLEAR_TIMING;
  if (cue.kind === "offensive-transfer") return OFFENSIVE_TRANSFER_TIMING;
  if (cue.kind === "nuke") return NUKE_TIMING;
  if (cue.kind === "garbage-rise") {
    return garbageTimingFor(cue.rowCount, garbageCadence);
  }
  if (cue.kind === "collapse") return COLLAPSE_TIMING;
  if (
    cue.kind === "barrier" ||
    cue.kind === "blackout" ||
    cue.kind === "scramble" ||
    cue.kind === "monomino-rush" ||
    cue.kind === "acid-rain" ||
    cue.kind === "ghost-jam"
  ) {
    return STATUS_POWER_TIMING;
  }
  if (cue.kind === "special-chain") {
    const blockingUntilMs = Math.min(
      400,
      80 + Math.max(1, orderedSpecials(cue).length) * SPECIAL_STEP_MS,
    );
    return {
      impactAtMs: 80,
      blockingUntilMs,
      durationMs: blockingUntilMs + 160,
    };
  }
  if (cue.kind === "acid-dissolve") {
    const blockingUntilMs = 40 + acidStepMs(cue) * acidRows(cue).length;
    return {
      impactAtMs: 40,
      blockingUntilMs,
      durationMs: blockingUntilMs + 160,
    };
  }
  return STATUS_POWER_TIMING;
};

const clampProgress = (value: number): number => Math.max(0, Math.min(1, value));

interface GarbageProgress {
  readonly liftRows: number;
  readonly activeRow: number;
  readonly rowProgress: number;
  readonly settledRows: number;
}

interface GarbageSeatImpact {
  readonly row: number;
  readonly pulse: number;
  readonly strength: number;
}

const garbageProgressAt = (
  cue: GarbageRiseCue,
  elapsedMs: number,
  cadence: GarbageCadence,
): GarbageProgress => {
  const rows = Math.max(1, Math.round(cue.rowCount));
  const liftElapsed = elapsedMs - cadence.pressureMs;
  if (liftElapsed <= 0) {
    return { liftRows: 0, activeRow: 0, rowProgress: 0, settledRows: 0 };
  }
  const progress = Array.from({ length: rows }, (_, index) =>
    clampProgress(
      (liftElapsed - index * cadence.rowIntervalMs) / cadence.rowLiftMs,
    )
  );
  const activeRow = Math.min(
    rows - 1,
    Math.max(0, Math.floor(liftElapsed / cadence.rowIntervalMs)),
  );
  return {
    liftRows: progress.reduce((total, value) => total + value, 0),
    activeRow,
    rowProgress: progress[activeRow] ?? 0,
    settledRows: progress.filter((value) => value >= 1).length,
  };
};

const garbageSeatImpactAt = (
  cue: GarbageRiseCue,
  elapsedMs: number,
  cadence: GarbageCadence,
): GarbageSeatImpact | null => {
  const rows = Math.max(1, Math.round(cue.rowCount));
  const firstSeatMs = cadence.pressureMs + cadence.rowLiftMs;
  if (elapsedMs < firstSeatMs) return null;
  const row = Math.min(
    rows - 1,
    Math.floor((elapsedMs - firstSeatMs) / cadence.rowIntervalMs),
  );
  const sinceSeatMs = elapsedMs - firstSeatMs - row * cadence.rowIntervalMs;
  if (sinceSeatMs < 0 || sinceSeatMs >= 70) return null;
  return {
    row,
    pulse: 1 - sinceSeatMs / 70,
    strength: rows <= 1 ? 0 : row / (rows - 1),
  };
};

export class PresentationTimeline {
  readonly #scheduled: ScheduledCue[] = [];
  #reducedMotion = false;
  #reducedFlashes = false;
  #screenShake = true;
  #particleScale = 1;

  constructor(options: PresentationOptions = {}) {
    this.configure(options);
  }

  configure(options: PresentationOptions): void {
    if (options.reducedMotion !== undefined) this.#reducedMotion = options.reducedMotion;
    if (options.reducedFlashes !== undefined) this.#reducedFlashes = options.reducedFlashes;
    if (options.screenShake !== undefined) this.#screenShake = options.screenShake;
    if (options.particleScale !== undefined) {
      this.#particleScale = Math.max(0, Math.min(1, options.particleScale));
    }
  }

  schedule(cue: PresentationCue, startedAtMs: number): PresentationTiming {
    if (cue.kind === "garbage-rise") {
      return this.scheduleGarbage(cue, startedAtMs).plan.timing;
    }
    const scheduledStartMs = startedAtMs;
    const garbageCadence: GarbageCadence | undefined = undefined;
    const timing = timingFor(cue, garbageCadence);
    const duplicate = this.#scheduled.findIndex(
      (scheduled) => scheduled.cue.id === cue.id,
    );
    if (duplicate >= 0) {
      const existing = this.#scheduled[duplicate];
      if (existing !== undefined && existing.cue.kind === cue.kind) {
        this.#scheduled[duplicate] = { ...existing, cue };
        return timing;
      }
      this.#scheduled.splice(duplicate, 1);
    }
    this.#scheduled.push({
      cue,
      startedAtMs: scheduledStartMs,
      timing,
      ...(garbageCadence === undefined ? {} : { garbageCadence }),
    });
    if (this.#scheduled.length > MAX_SCHEDULED_CUES) {
      this.#scheduled.splice(0, this.#scheduled.length - MAX_SCHEDULED_CUES);
    }
    return timing;
  }

  scheduleGarbage(cue: GarbageRiseCue, requestedAtMs: number): GarbageScheduleResult {
    const duplicate = this.#scheduled.findIndex((scheduled) =>
      scheduled.cue.id === cue.id
    );
    const existing = duplicate >= 0 ? this.#scheduled[duplicate] : undefined;
    if (existing?.cue.kind === "garbage-rise") {
      this.#scheduled[duplicate] = { ...existing, cue };
      return {
        newlyScheduled: false,
        plan: {
          requestedAtMs: existing.requestedAtMs ?? existing.startedAtMs,
          startedAtMs: existing.startedAtMs,
          rowCount: Math.max(1, Math.round(cue.rowCount)),
          cadence: existing.garbageCadence ?? DEFAULT_GARBAGE_CADENCE,
          timing: existing.timing,
        },
      };
    }
    const tailBlockingAtMs = this.#scheduled.reduce((tail, scheduled) =>
      scheduled.cue.kind === "garbage-rise" &&
        scheduled.cue.board === cue.board &&
        scheduled.startedAtMs + scheduled.timing.blockingUntilMs > requestedAtMs
        ? Math.max(tail, scheduled.startedAtMs + scheduled.timing.blockingUntilMs)
        : tail,
    requestedAtMs);
    const plan = planGarbageSequence(cue.rowCount, requestedAtMs, tailBlockingAtMs);
    if (duplicate >= 0) this.#scheduled.splice(duplicate, 1);
    this.#scheduled.push({
      cue,
      requestedAtMs: plan.requestedAtMs,
      startedAtMs: plan.startedAtMs,
      timing: plan.timing,
      garbageCadence: plan.cadence,
    });
    if (this.#scheduled.length > MAX_SCHEDULED_CUES) {
      this.#scheduled.splice(0, this.#scheduled.length - MAX_SCHEDULED_CUES);
    }
    return { plan, newlyScheduled: true };
  }

  cancelGarbage(board?: PresentationBoard): void {
    for (let index = this.#scheduled.length - 1; index >= 0; index -= 1) {
      const cue = this.#scheduled[index]?.cue;
      if (cue?.kind === "garbage-rise" && (board === undefined || cue.board === board)) {
        this.#scheduled.splice(index, 1);
      }
    }
  }

  clear(): void {
    this.#scheduled.length = 0;
  }

  frameAt(atMs: number): PresentationFrame {
    let blocking = false;
    let shake: PresentationShake | null = null;
    const effects: PresentationEffect[] = [];
    for (const scheduled of this.#scheduled) {
      const elapsed = atMs - scheduled.startedAtMs;
      if (elapsed < 0 || elapsed >= scheduled.timing.durationMs) continue;
      blocking ||= elapsed < scheduled.timing.blockingUntilMs;
      const instantAction = scheduled.cue.kind === "barrier-hit";
      const stage: PresentationStage = instantAction
        ? "action"
        : elapsed < scheduled.timing.impactAtMs
          ? "anticipation"
          : elapsed < scheduled.timing.blockingUntilMs
            ? "action"
            : "follow-through";
      const stageStart = instantAction
        ? 0
        : stage === "anticipation"
          ? 0
          : stage === "action"
            ? scheduled.timing.impactAtMs
            : scheduled.timing.blockingUntilMs;
      const stageEnd = instantAction
        ? scheduled.timing.durationMs
        : stage === "anticipation"
          ? scheduled.timing.impactAtMs
          : stage === "action"
            ? scheduled.timing.blockingUntilMs
            : scheduled.timing.durationMs;
      const stageProgress = clampProgress(
        (elapsed - stageStart) / (stageEnd - stageStart),
      );
      const moment: PresentationMoment = scheduled.cue.kind === "offensive-transfer"
        ? elapsed < 80
          ? "charge"
          : elapsed < scheduled.timing.impactAtMs
            ? "travel"
            : stage === "action"
              ? "impact"
              : "particles"
        : scheduled.cue.kind === "nuke"
          ? stage === "anticipation"
            ? "reticle"
            : stage === "action"
              ? "shockwave"
              : "particles"
          : scheduled.cue.kind === "acid-dissolve"
            ? stage === "anticipation"
              ? "splash"
              : stage === "action"
                ? "dissolve"
                : "particles"
          : scheduled.cue.kind === "garbage-rise"
            ? stage === "anticipation"
              ? "pressure"
              : stage === "action"
                ? "lift"
                : "particles"
          : scheduled.cue.kind === "collapse"
            ? elapsed < scheduled.timing.impactAtMs
              ? "charge"
              : elapsed < scheduled.timing.blockingUntilMs
                ? "fall"
                : "particles"
          : scheduled.cue.kind === "barrier"
            ? stage === "follow-through" ? "particles" : "rail"
          : scheduled.cue.kind === "blackout"
            ? stage === "follow-through" ? "particles" : "veil"
          : scheduled.cue.kind === "scramble"
            ? stage === "follow-through" ? "particles" : "glitch"
          : scheduled.cue.kind === "ghost-jam"
            ? stage === "anticipation"
              ? "ghost-flicker"
              : stage === "action" ? "ghost-dissolve" : "particles"
          : scheduled.cue.kind === "monomino-rush"
            ? stage === "follow-through" ? "particles" : "fracture"
          : scheduled.cue.kind === "acid-rain"
            ? stage === "anticipation"
              ? "charge"
              : stage === "action" ? "impact" : "particles"
          : scheduled.cue.kind === "special-chain"
            ? stage === "anticipation" ? "charge" : "special-burst"
          : stage === "anticipation"
            ? "compress"
            : stage === "action"
              ? "impact"
            : "particles";
      const garbageProgress = scheduled.cue.kind === "garbage-rise"
        ? garbageProgressAt(
            scheduled.cue,
            elapsed,
            scheduled.garbageCadence ?? DEFAULT_GARBAGE_CADENCE,
          )
        : null;
      const garbageBoard = scheduled.cue.kind === "garbage-rise"
        ? scheduled.cue.board
        : null;
      const garbageStack = scheduled.cue.kind === "garbage-rise"
        ? this.#scheduled.reduce(
            (stack, candidate) => {
              if (
                candidate.cue.kind !== "garbage-rise" ||
                candidate.cue.board !== garbageBoard ||
                (candidate.requestedAtMs ?? candidate.startedAtMs) > atMs
              ) {
                return stack;
              }
              const rows = Math.max(1, Math.round(candidate.cue.rowCount));
              const elapsed = atMs - candidate.startedAtMs;
              const lifted = elapsed < 0
                ? 0
                : elapsed >= candidate.timing.blockingUntilMs
                  ? rows
                  : garbageProgressAt(
                      candidate.cue,
                      elapsed,
                      candidate.garbageCadence ?? DEFAULT_GARBAGE_CADENCE,
                    ).liftRows;
              return {
                rows: stack.rows + rows,
                liftRows: stack.liftRows + lifted,
              };
            },
            { rows: 0, liftRows: 0 },
          )
        : null;
      const garbageSeatImpact = scheduled.cue.kind === "garbage-rise"
        ? garbageSeatImpactAt(
            scheduled.cue,
            elapsed,
            scheduled.garbageCadence ?? DEFAULT_GARBAGE_CADENCE,
          )
        : null;
      const particleCount = this.#reducedMotion || scheduled.cue.kind === "barrier-hit"
        ? 0
        : scheduled.cue.kind === "garbage-rise"
          ? garbageSeatImpact === null
            ? 0
            : Math.round((8 + 8 * garbageSeatImpact.strength) * this.#particleScale)
        : Math.round(
            (scheduled.cue.kind === "nuke" && stage !== "anticipation"
              ? 48
              : scheduled.cue.kind === "line-clear" && scheduled.cue.rows.length >= 4
                ? 32
                : 12) *
              this.#particleScale,
          );
      const majorImpact =
        scheduled.cue.kind === "nuke" ||
        (scheduled.cue.kind === "line-clear" && scheduled.cue.rows.length >= 4) ||
        (scheduled.cue.kind === "garbage-rise" && scheduled.cue.rowCount >= 4);
      if (
        shake === null &&
        garbageSeatImpact !== null &&
        this.#screenShake &&
        !this.#reducedMotion
      ) {
        const magnitude = (0.28 + 0.27 * garbageSeatImpact.strength) *
          garbageSeatImpact.pulse;
        shake = {
          x: Math.sin(elapsed * 0.31) * magnitude,
          y: Math.cos(elapsed * 0.23) * magnitude,
          magnitude,
        };
      } else if (
        shake === null &&
        this.#screenShake &&
        !this.#reducedMotion &&
        majorImpact &&
        stage === "action"
      ) {
        const magnitude = 0.8 * (1 - stageProgress);
        shake = {
          x: Math.sin(elapsed * 0.31) * magnitude,
          y: Math.cos(elapsed * 0.23) * magnitude,
          magnitude,
        };
      }
      effects.push({
        id: scheduled.cue.id,
        kind: scheduled.cue.kind,
        board: scheduled.cue.kind === "offensive-transfer"
          ? scheduled.cue.target
          : scheduled.cue.board,
        stage,
        moment,
        progress: clampProgress(elapsed / scheduled.timing.durationMs),
        stageProgress,
        visualStyle: this.#reducedMotion ? "fade" : "motion",
        particleCount,
        flash: scheduled.cue.kind !== "garbage-rise" &&
          !this.#reducedFlashes && stage === "action",
        ...(scheduled.cue.kind === "line-clear"
          ? { rows: scheduled.cue.rows }
          : scheduled.cue.kind === "offensive-transfer"
            ? {
              source: scheduled.cue.source,
              target: scheduled.cue.target,
              attack: scheduled.cue.attack,
            }
            : scheduled.cue.kind === "nuke"
              ? {
                center: scheduled.cue.center,
                footprint: { width: 5 as const, height: 5 as const },
              }
              : scheduled.cue.kind === "acid-dissolve"
                ? {
                  column: scheduled.cue.column,
                  resolvedRows: acidRows(scheduled.cue).slice(
                    0,
                    elapsed < scheduled.timing.impactAtMs
                      ? 0
                      : Math.min(
                          acidRows(scheduled.cue).length,
                          1 + Math.floor(
                            (elapsed - scheduled.timing.impactAtMs) /
                            acidStepMs(scheduled.cue),
                          ),
                        ),
                  ),
                }
                : scheduled.cue.kind === "garbage-rise"
                  ? {
                      rowCount: scheduled.cue.rowCount,
                      garbageLiftRows: garbageProgress?.liftRows ?? 0,
                      garbageActiveRow: garbageProgress?.activeRow ?? 0,
                      garbageRowProgress: garbageProgress?.rowProgress ?? 0,
                      garbageSettledRows: garbageProgress?.settledRows ?? 0,
                      garbageStackRows: garbageStack?.rows ?? scheduled.cue.rowCount,
                      garbageStackLiftRows: garbageStack?.liftRows ??
                        garbageProgress?.liftRows ?? 0,
                      garbageSeatPulse: garbageSeatImpact?.pulse ?? 0,
                    }
                  : scheduled.cue.kind === "collapse"
                    ? {
                        completedRows: scheduled.cue.completedRows,
                        movements: scheduled.cue.movements,
                      }
                    : scheduled.cue.kind === "barrier"
                      ? { capacity: scheduled.cue.capacity }
                      : scheduled.cue.kind === "ghost-jam"
                        ? { ghostCells: scheduled.cue.ghostCells }
                      : scheduled.cue.kind === "special-chain"
                        ? {
                            resolvedSpecials: orderedSpecials(scheduled.cue).slice(
                              0,
                              elapsed < scheduled.timing.impactAtMs
                                ? 0
                                : Math.min(
                                    orderedSpecials(scheduled.cue).length,
                                    1 + Math.floor(
                                      (elapsed - scheduled.timing.impactAtMs) /
                                      SPECIAL_STEP_MS,
                                    ),
                                  ),
                            ),
                          }
                      : {}),
      });
    }
    for (let index = this.#scheduled.length - 1; index >= 0; index -= 1) {
      const scheduled = this.#scheduled[index];
      if (
        scheduled !== undefined &&
        atMs - scheduled.startedAtMs >= scheduled.timing.durationMs
      ) {
        this.#scheduled.splice(index, 1);
      }
    }
    return { atMs, blocking, effects, shake };
  }
}
