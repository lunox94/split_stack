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
        0.11 + strength * 0.02,
        "sawtooth",
        48 - strength * 7,
        startsAtMs,
      ),
    ],
    impact: [
      tone(
        245 - strength * 30,
        105 + strength * 25,
        0.14 + strength * 0.028,
        "square",
        92 - strength * 12,
        seatsAtMs,
      ),
    ],
  };
}

export const CUE_DEFINITIONS: Readonly<Record<AudioCue, CueDefinition>> = {
  move: [tone(180, 34, 0.035, "square", 210)],
  rotate: [tone(280, 55, 0.045, "triangle", 420)],
  hold: [tone(420, 75, 0.05, "sine", 260)],
  "soft-drop": [tone(120, 30, 0.025, "square", 100)],
  "hard-drop": [tone(135, 105, 0.085, "sawtooth", 48)],
  lock: [tone(82, 75, 0.065, "square", 64)],
  single: [
    tone(510, 50, 0.075, "triangle", 720),
    tone(190, 90, 0.07, "square", 120, 36),
  ],
  double: [
    tone(510, 50, 0.075, "triangle", 720),
    tone(190, 90, 0.075, "square", 112, 36),
    tone(690, 120, 0.06, "triangle", 920, 68),
  ],
  triple: [
    tone(510, 50, 0.075, "triangle", 720),
    tone(180, 90, 0.07, "square", 98, 34),
    tone(690, 120, 0.07, "triangle", 980, 64),
    tone(920, 120, 0.07, "sine", 1_220, 122),
  ],
  "four-line": [
    tone(510, 50, 0.075, "triangle", 720),
    tone(145, 90, 0.085, "sawtooth", 72, 32),
    tone(660, 132, 0.075, "triangle", 990, 62),
    tone(880, 156, 0.075, "triangle", 1_320, 116),
    tone(1_320, 200, 0.06, "sine", 1_760, 174),
  ],
  "t-spin": [tone(520, 80, 0.07, "square", 780), tone(1_040, 150, 0.06, "sine", 880, 65)],
  "garbage-warning": [tone(150, 130, 0.07, "square", 110), tone(150, 130, 0.065, "square", 110, 180)],
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
  "power-blackout": [tone(190, 400, 0.075, "sawtooth", 45)],
  "power-barrier": [tone(260, 240, 0.07, "sine", 780), tone(520, 260, 0.045, "triangle", 680, 20)],
  "nuke-impact": [
    tone(96, 240, 0.1, "sawtooth", 30),
    tone(380, 125, 0.045, "triangle", 95, 35),
  ],
  "collapse-impact": [
    tone(360, 220, 0.07, "triangle", 84),
    tone(105, 180, 0.075, "sawtooth", 48, 70),
  ],
  "acid-consume": [tone(520, 38, 0.035, "sawtooth", 170)],
  "oversize-arrival": [
    tone(180, 180, 0.075, "triangle", 390),
    tone(92, 260, 0.105, "sawtooth", 48, 70),
  ],
  "ghost-jam-arrival": [
    tone(1_180, 210, 0.06, "square", 310),
    tone(790, 230, 0.05, "triangle", 180, 45),
  ],
  "glitch-preview-low": [tone(620, 82, 0.026, "square", 560)],
  "glitch-preview-high": [tone(880, 82, 0.024, "square", 960)],
  "glitch-preview-arrival": [
    tone(620, 70, 0.035, "square", 780),
    tone(880, 90, 0.03, "square", 660, 72),
  ],
  "level-up": [tone(440, 90, 0.06), tone(660, 90, 0.06, "sine", undefined, 80), tone(880, 140, 0.06, "sine", undefined, 160)],
  countdown: [tone(520, 85, 0.06, "square")],
  victory: [tone(523, 130, 0.07), tone(659, 130, 0.07, "sine", undefined, 120), tone(784, 300, 0.075, "sine", undefined, 240)],
  defeat: [tone(260, 180, 0.07, "triangle", 210), tone(160, 360, 0.07, "triangle", 80, 150)],
  draw: [tone(392, 180, 0.06, "triangle"), tone(392, 250, 0.05, "sine", 350, 170)],
};

export const CUE_POLICIES: Readonly<Partial<Record<AudioCue, CuePolicy>>> = {
  move: { priority: 0, retriggerMs: 30 },
  "soft-drop": { priority: 0, retriggerMs: 30 },
  rotate: { priority: 1, retriggerMs: 0 },
  hold: { priority: 1, retriggerMs: 0 },
  "hard-drop": { priority: 1, retriggerMs: 0 },
  "nuke-impact": {
    priority: 3,
    retriggerMs: 0,
    musicDuck: { durationMs: 300, amount: 0.88 },
  },
  "collapse-impact": {
    priority: 3,
    retriggerMs: 0,
    musicDuck: { durationMs: 300, amount: 0.88 },
  },
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
    tone(360, 85, 0.065, "square", 720),
    tone(720, 85, 0.06, "square", 240, 90),
  ],
  "power-nuke": [tone(110, 360, 0.12, "sawtooth", 28)],
  "power-collapse": [tone(520, 300, 0.075, "triangle", 95)],
  "power-monomino-rush": [
    tone(880, 55, 0.045, "square"),
    tone(1_100, 55, 0.045, "square", undefined, 65),
    tone(1_320, 80, 0.04, "square", undefined, 130),
  ],
  "power-acid-rain": [tone(620, 420, 0.07, "sawtooth", 170)],
  "power-oversize": [
    tone(180, 180, 0.075, "triangle", 390),
    tone(92, 260, 0.105, "sawtooth", 48, 70),
    tone(390, 150, 0.055, "sine", 520, 150),
  ],
  "power-ghost-jam": [
    tone(1_180, 210, 0.06, "square", 310),
    tone(790, 230, 0.05, "triangle", 180, 45),
  ],
};

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
