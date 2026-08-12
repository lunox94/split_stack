import { RULES } from "../config/rules";
import {
  DEFAULT_GARBAGE_CADENCE,
  type GarbageCadence,
} from "../app/garbage-sequence";

export type AudioCue =
  | "move"
  | "rotate"
  | "hold"
  | "soft-drop"
  | "hard-drop"
  | "lock"
  | "single"
  | "double"
  | "triple"
  | "four-line"
  | "t-spin"
  | "garbage-warning"
  | "garbage-rise"
  | "special-trigger"
  | "hollow-cross"
  | "power-warning"
  | "power-blackout"
  | "power-barrier"
  | "nuke-impact"
  | "collapse-impact"
  | "acid-consume"
  | "oversize-arrival"
  | "ghost-jam-arrival"
  | "glitch-preview-low"
  | "glitch-preview-high"
  | "glitch-preview-arrival"
  | "level-up"
  | "countdown"
  | "victory"
  | "defeat"
  | "draw";

export type CalloutCue =
  | "combo-2"
  | "combo-3"
  | "combo-4"
  | "combo-5-plus"
  | "power-scramble"
  | "power-nuke"
  | "power-collapse"
  | "power-monomino-rush"
  | "power-acid-rain"
  | "power-oversize"
  | "power-ghost-jam";

export interface CueTone {
  readonly frequency: number;
  readonly endFrequency?: number;
  readonly delayMs?: number;
  readonly durationMs: number;
  readonly gain: number;
  readonly wave: OscillatorType;
}

export type CueDefinition = readonly CueTone[];

export interface CalloutAsset {
  readonly assetUrl: string;
  readonly ducksMusic: boolean;
}

export interface CuePolicy {
  readonly priority: number;
  readonly retriggerMs: number;
  readonly gain?: number;
  readonly musicDuck?: {
    readonly durationMs: number;
    readonly amount: number;
  };
}

const tone = (
  frequency: number,
  durationMs: number,
  gain: number,
  wave: OscillatorType = "sine",
  endFrequency?: number,
  delayMs?: number,
): CueTone => {
  const value: CueTone = { frequency, durationMs, gain, wave };
  if (endFrequency !== undefined) {
    return delayMs === undefined
      ? { ...value, endFrequency }
      : { ...value, endFrequency, delayMs };
  }
  return delayMs === undefined ? value : { ...value, delayMs };
};

export const GLITCH_PREVIEW_STEP_MS = RULES.special.glitchCycleMs;

export interface GarbageRowCue {
  readonly rumble: CueDefinition;
  readonly impact: CueDefinition;
}

/** Builds one deterministic lift-and-seat identity within a garbage batch. */
export function garbageRiseCueForRow(
  rowIndex: number,
  rowCount: number,
  cadence: GarbageCadence = DEFAULT_GARBAGE_CADENCE,
  batchDelayMs = 0,
): GarbageRowCue {
  const maxBatchRows = RULES.garbage.rowsPerLockCap;
  const rows = Math.max(1, Math.min(maxBatchRows, Math.round(rowCount)));
  const index = Math.max(0, Math.min(rows - 1, Math.round(rowIndex)));
  const strength = rows <= 1 ? 0 : index / (rows - 1);
  const startsAtMs = batchDelayMs + cadence.pressureMs +
    index * cadence.rowIntervalMs;
  const seatsAtMs = startsAtMs + cadence.rowLiftMs;
  return {
    rumble: [
      tone(
        76 - strength * 10,
        265 + strength * 55,
        0.12 + strength * 0.022,
        "triangle",
        48 - strength * 7,
        startsAtMs,
      ),
    ],
    impact: [
      tone(
        290 - strength * 35,
        145 + strength * 30,
        0.18 + strength * 0.034,
        "triangle",
        96 - strength * 12,
        seatsAtMs,
      ),
    ],
  };
}

export const CUE_DEFINITIONS: Readonly<Record<AudioCue, CueDefinition>> = {
  move: [tone(260, 48, 0.052, "triangle", 390)],
  rotate: [tone(280, 55, 0.045, "triangle", 420)],
  hold: [tone(420, 75, 0.05, "sine", 260)],
  "soft-drop": [
    tone(210, 52, 0.052, "triangle", 150),
    tone(840, 42, 0.034, "sine", 620, 4),
  ],
  "hard-drop": [
    tone(145, 145, 0.125, "triangle", 48),
    tone(980, 82, 0.058, "triangle", 430, 8),
  ],
  lock: [
    tone(105, 100, 0.095, "triangle", 68),
    tone(720, 62, 0.047, "sine", 410, 5),
  ],
  single: [
    tone(510, 50, 0.075, "triangle", 720),
    tone(190, 90, 0.07, "triangle", 120, 36),
  ],
  double: [
    tone(510, 50, 0.075, "triangle", 720),
    tone(190, 90, 0.075, "triangle", 112, 36),
    tone(690, 120, 0.06, "triangle", 920, 68),
  ],
  triple: [
    tone(510, 50, 0.075, "triangle", 720),
    tone(180, 90, 0.07, "triangle", 98, 34),
    tone(690, 120, 0.07, "triangle", 980, 64),
    tone(920, 120, 0.07, "sine", 1_220, 122),
  ],
  "four-line": [
    tone(510, 50, 0.075, "triangle", 720),
    tone(145, 90, 0.085, "triangle", 72, 32),
    tone(660, 132, 0.075, "triangle", 990, 62),
    tone(880, 156, 0.075, "triangle", 1_320, 116),
    tone(1_320, 200, 0.06, "sine", 1_760, 174),
  ],
  "t-spin": [tone(520, 80, 0.07, "triangle", 780), tone(1_040, 150, 0.06, "sine", 880, 65)],
  "garbage-warning": [
    tone(150, 150, 0.09, "triangle", 105),
    tone(720, 92, 0.045, "sine", 520, 10),
    tone(150, 150, 0.085, "triangle", 105, 190),
    tone(720, 92, 0.042, "sine", 520, 200),
  ],
  "garbage-rise": [
    ...garbageRiseCueForRow(0, 1).rumble,
    ...garbageRiseCueForRow(0, 1).impact,
  ],
  "special-trigger": [tone(700, 80, 0.065, "triangle", 1_100), tone(1_400, 120, 0.045, "sine", 900, 55)],
  "hollow-cross": [
    tone(310, 130, 0.05, "triangle", 265),
    tone(1_860, 95, 0.025, "sine", 1_420, 24),
    tone(465, 110, 0.035, "sine", 620, 62),
  ],
  "power-warning": [tone(760, 65, 0.05, "sine", 920), tone(920, 80, 0.045, "sine", 760, 90)],
  "power-blackout": [
    tone(190, 460, 0.11, "triangle", 45),
    tone(1_350, 330, 0.052, "sine", 280, 28),
  ],
  "power-barrier": [tone(260, 240, 0.07, "sine", 780), tone(520, 260, 0.045, "triangle", 680, 20)],
  "nuke-impact": [
    tone(96, 320, 0.14, "triangle", 30),
    tone(460, 190, 0.065, "triangle", 110, 24),
    tone(2_300, 230, 0.07, "sine", 620, 12),
  ],
  "collapse-impact": [
    tone(360, 220, 0.07, "triangle", 84),
    tone(105, 180, 0.075, "triangle", 48, 70),
  ],
  "acid-consume": [
    tone(560, 125, 0.075, "triangle", 170),
    tone(1_600, 95, 0.047, "sine", 620, 18),
  ],
  "oversize-arrival": [
    tone(180, 220, 0.105, "triangle", 390),
    tone(92, 310, 0.135, "triangle", 48, 55),
    tone(820, 210, 0.055, "sine", 420, 42),
    tone(1_640, 145, 0.035, "sine", 780, 95),
  ],
  "ghost-jam-arrival": [
    tone(1_180, 210, 0.06, "triangle", 310),
    tone(790, 230, 0.05, "triangle", 180, 45),
  ],
  "glitch-preview-low": [tone(620, 82, 0.029, "triangle", 560)],
  "glitch-preview-high": [tone(880, 82, 0.027, "triangle", 960)],
  "glitch-preview-arrival": [
    tone(620, 70, 0.035, "triangle", 780),
    tone(880, 90, 0.03, "triangle", 660, 72),
  ],
  "level-up": [tone(440, 90, 0.06), tone(660, 90, 0.06, "sine", undefined, 80), tone(880, 140, 0.06, "sine", undefined, 160)],
  countdown: [tone(520, 85, 0.06, "triangle")],
  victory: [tone(523, 130, 0.07), tone(659, 130, 0.07, "sine", undefined, 120), tone(784, 300, 0.075, "sine", undefined, 240)],
  defeat: [tone(260, 180, 0.07, "triangle", 210), tone(160, 360, 0.07, "triangle", 80, 150)],
  draw: [tone(392, 180, 0.06, "triangle"), tone(392, 250, 0.05, "sine", 350, 170)],
};

/** Ordered production SFX registry used by the temporary listening library. */
export const AUDIO_CUES: readonly AudioCue[] = Object.freeze(
  Object.keys(CUE_DEFINITIONS) as AudioCue[],
);

export const CUE_POLICIES: Readonly<Partial<Record<AudioCue, CuePolicy>>> = {
  move: { priority: 0, retriggerMs: 30, gain: 1.1 },
  "soft-drop": { priority: 0, retriggerMs: 30, gain: 1.1 },
  rotate: { priority: 1, retriggerMs: 0 },
  hold: { priority: 1, retriggerMs: 0 },
  "hard-drop": {
    priority: 1,
    retriggerMs: 0,
    gain: 1.05,
    musicDuck: { durationMs: 140, amount: 0.86 },
  },
  lock: {
    priority: 1,
    retriggerMs: 0,
    gain: 1.05,
    musicDuck: { durationMs: 110, amount: 0.9 },
  },
  single: {
    priority: 2,
    retriggerMs: 0,
    gain: 1.15,
    musicDuck: { durationMs: 240, amount: 0.78 },
  },
  double: {
    priority: 2,
    retriggerMs: 0,
    gain: 1.12,
    musicDuck: { durationMs: 280, amount: 0.74 },
  },
  triple: {
    priority: 2,
    retriggerMs: 0,
    gain: 1.08,
    musicDuck: { durationMs: 320, amount: 0.7 },
  },
  "four-line": {
    priority: 2,
    retriggerMs: 0,
    gain: 1.05,
    musicDuck: { durationMs: 380, amount: 0.66 },
  },
  "t-spin": {
    priority: 2,
    retriggerMs: 0,
    gain: 1.1,
    musicDuck: { durationMs: 340, amount: 0.68 },
  },
  "garbage-warning": { priority: 2, retriggerMs: 0, gain: 1.1 },
  "special-trigger": { priority: 2, retriggerMs: 0, gain: 1.12 },
  "hollow-cross": { priority: 2, retriggerMs: 0, gain: 1.18 },
  "power-warning": { priority: 2, retriggerMs: 0, gain: 1.15 },
  "power-blackout": {
    priority: 2,
    retriggerMs: 0,
    gain: 1.1,
    musicDuck: { durationMs: 360, amount: 0.74 },
  },
  "power-barrier": {
    priority: 2,
    retriggerMs: 0,
    gain: 1.08,
    musicDuck: { durationMs: 300, amount: 0.78 },
  },
  "nuke-impact": {
    priority: 3,
    retriggerMs: 0,
    musicDuck: { durationMs: 360, amount: 0.68 },
  },
  "collapse-impact": {
    priority: 3,
    retriggerMs: 0,
    gain: 1.05,
    musicDuck: { durationMs: 340, amount: 0.72 },
  },
  "acid-consume": { priority: 2, retriggerMs: 0, gain: 1.28 },
  "ghost-jam-arrival": { priority: 2, retriggerMs: 0, gain: 1.12 },
};

export const PROCEDURAL_CALLOUT_GAIN: Readonly<Record<CalloutCue, number>> = {
  "combo-2": 1.1,
  "combo-3": 1.08,
  "combo-4": 1.05,
  "combo-5-plus": 1.22,
  "power-scramble": 1.35,
  "power-nuke": 1.08,
  "power-collapse": 1.22,
  "power-monomino-rush": 1.55,
  "power-acid-rain": 1.25,
  "power-oversize": 1.05,
  "power-ghost-jam": 1.28,
};

export const CALLOUT_DEFINITIONS: Readonly<Record<CalloutCue, CueDefinition>> = {
  "combo-2": [tone(660, 85, 0.045, "triangle", 820)],
  "combo-3": [
    tone(720, 85, 0.045, "triangle", 900),
    tone(980, 90, 0.035, "sine", 1_120, 55),
  ],
  "combo-4": [
    tone(780, 90, 0.045, "triangle", 980),
    tone(1_040, 95, 0.037, "sine", 1_260, 45),
    tone(1_300, 100, 0.03, "sine", 1_520, 75),
  ],
  "combo-5-plus": [
    tone(840, 95, 0.045, "triangle", 1_080),
    tone(1_120, 105, 0.037, "sine", 1_420, 38),
    tone(1_480, 115, 0.03, "sine", 1_760, 68),
  ],
  "power-scramble": [
    tone(360, 85, 0.065, "triangle", 720),
    tone(720, 85, 0.06, "triangle", 240, 90),
    tone(1_440, 150, 0.025, "sine", 1_080, 35),
  ],
  "power-nuke": [
    tone(110, 360, 0.12, "triangle", 28),
    tone(440, 260, 0.04, "sine", 180, 35),
  ],
  "power-collapse": [
    tone(520, 300, 0.075, "triangle", 95),
    tone(1_040, 220, 0.032, "sine", 620, 45),
  ],
  "power-monomino-rush": [
    tone(880, 85, 0.045, "triangle"),
    tone(1_100, 85, 0.045, "triangle", undefined, 70),
    tone(1_320, 110, 0.04, "triangle", undefined, 140),
    tone(440, 220, 0.028, "sine", 660, 35),
  ],
  "power-acid-rain": [
    tone(620, 420, 0.07, "triangle", 170),
    tone(1_240, 300, 0.028, "sine", 740, 45),
  ],
  "power-oversize": [
    tone(180, 180, 0.075, "triangle", 390),
    tone(92, 260, 0.105, "triangle", 48, 70),
    tone(390, 150, 0.055, "sine", 520, 150),
    tone(780, 190, 0.026, "sine", 520, 95),
  ],
  "power-ghost-jam": [
    tone(1_180, 210, 0.06, "triangle", 310),
    tone(790, 230, 0.05, "triangle", 180, 45),
    tone(1_580, 190, 0.025, "sine", 930, 70),
  ],
};

/** Ordered Callout registry used by the temporary listening library. */
export const CALLOUT_CUES: readonly CalloutCue[] = Object.freeze(
  Object.keys(CALLOUT_DEFINITIONS) as CalloutCue[],
);

/**
 * Optional recorded callouts keyed by their semantic cue. The synthesized
 * definitions above remain the offline-safe fallback when an asset cannot be
 * fetched or decoded by a host WebView.
 */
export const CALLOUT_ASSETS: Readonly<Partial<Record<CalloutCue, CalloutAsset>>> = {
  "combo-2": {
    assetUrl: "./audio/callouts/good.mp3",
    ducksMusic: true,
  },
  "combo-3": {
    assetUrl: "./audio/callouts/excellent.mp3",
    ducksMusic: true,
  },
  "combo-4": {
    assetUrl: "./audio/callouts/incredible.mp3",
    ducksMusic: true,
  },
};
