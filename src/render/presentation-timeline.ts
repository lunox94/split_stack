import type { SpecialKind } from "../domain/types";
import type { CollapseMovement } from "../domain/powers";

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

const GARBAGE_RISE_TIMING: PresentationTiming = {
  impactAtMs: 100,
  blockingUntilMs: 250,
  durationMs: 400,
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

const timingFor = (cue: PresentationCue): PresentationTiming => {
  if (cue.kind === "barrier-hit") return BARRIER_HIT_TIMING;
  if (cue.kind === "line-clear") return LINE_CLEAR_TIMING;
  if (cue.kind === "offensive-transfer") return OFFENSIVE_TRANSFER_TIMING;
  if (cue.kind === "nuke") return NUKE_TIMING;
  if (cue.kind === "garbage-rise") return GARBAGE_RISE_TIMING;
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

export class PresentationTimeline {
  readonly #scheduled: ScheduledCue[] = [];
  readonly #reducedMotion: boolean;
  readonly #reducedFlashes: boolean;
  readonly #screenShake: boolean;
  readonly #particleScale: number;

  constructor(options: PresentationOptions = {}) {
    this.#reducedMotion = options.reducedMotion ?? false;
    this.#reducedFlashes = options.reducedFlashes ?? false;
    this.#screenShake = options.screenShake ?? true;
    this.#particleScale = Math.max(0, Math.min(1, options.particleScale ?? 1));
  }

  schedule(cue: PresentationCue, startedAtMs: number): PresentationTiming {
    const timing = timingFor(cue);
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
    this.#scheduled.push({ cue, startedAtMs, timing });
    if (this.#scheduled.length > MAX_SCHEDULED_CUES) {
      this.#scheduled.splice(0, this.#scheduled.length - MAX_SCHEDULED_CUES);
    }
    return timing;
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
      const particleCount = this.#reducedMotion || scheduled.cue.kind === "barrier-hit"
        ? 0
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
        flash: !this.#reducedFlashes && stage === "action",
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
                  ? { rowCount: scheduled.cue.rowCount }
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
