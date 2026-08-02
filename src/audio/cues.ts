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
  | "power-warning"
  | "power-blackout"
  | "power-scramble"
  | "power-nuke"
  | "power-barrier"
  | "power-collapse"
  | "power-monomino-rush"
  | "power-acid-rain"
  | "level-up"
  | "countdown"
  | "victory"
  | "defeat"
  | "draw";

export interface CueTone {
  readonly frequency: number;
  readonly endFrequency?: number;
  readonly delayMs?: number;
  readonly durationMs: number;
  readonly gain: number;
  readonly wave: OscillatorType;
}

export type CueDefinition = readonly CueTone[];

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

export const CUE_DEFINITIONS: Readonly<Record<AudioCue, CueDefinition>> = {
  move: [tone(180, 34, 0.035, "square", 210)],
  rotate: [tone(280, 55, 0.045, "triangle", 420)],
  hold: [tone(420, 75, 0.05, "sine", 260)],
  "soft-drop": [tone(120, 30, 0.025, "square", 100)],
  "hard-drop": [tone(135, 105, 0.085, "sawtooth", 48)],
  lock: [tone(82, 75, 0.065, "square", 64)],
  single: [tone(440, 100, 0.07), tone(660, 110, 0.055, "sine", 700, 70)],
  double: [tone(440, 90, 0.07), tone(660, 120, 0.06, "sine", 820, 75)],
  triple: [tone(440, 85, 0.07), tone(700, 140, 0.065, "triangle", 980, 70)],
  "four-line": [
    tone(330, 90, 0.075, "triangle"),
    tone(660, 170, 0.075, "triangle", 1_320, 75),
  ],
  "t-spin": [tone(520, 80, 0.07, "square", 780), tone(1_040, 150, 0.06, "sine", 880, 65)],
  "garbage-warning": [tone(150, 130, 0.07, "square", 110), tone(150, 130, 0.065, "square", 110, 180)],
  "garbage-rise": [tone(74, 180, 0.09, "sawtooth", 155)],
  "special-trigger": [tone(700, 80, 0.065, "triangle", 1_100), tone(1_400, 120, 0.045, "sine", 900, 55)],
  "power-warning": [tone(760, 65, 0.05, "sine", 920), tone(920, 80, 0.045, "sine", 760, 90)],
  "power-blackout": [tone(190, 400, 0.075, "sawtooth", 45)],
  "power-scramble": [tone(360, 85, 0.065, "square", 720), tone(720, 85, 0.06, "square", 240, 90)],
  "power-nuke": [tone(110, 360, 0.12, "sawtooth", 28)],
  "power-barrier": [tone(260, 240, 0.07, "sine", 780), tone(520, 260, 0.045, "triangle", 680, 20)],
  "power-collapse": [tone(520, 300, 0.075, "triangle", 95)],
  "power-monomino-rush": [tone(880, 55, 0.045, "square"), tone(1_100, 55, 0.045, "square", undefined, 65), tone(1_320, 80, 0.04, "square", undefined, 130)],
  "power-acid-rain": [tone(620, 420, 0.07, "sawtooth", 170)],
  "level-up": [tone(440, 90, 0.06), tone(660, 90, 0.06, "sine", undefined, 80), tone(880, 140, 0.06, "sine", undefined, 160)],
  countdown: [tone(520, 85, 0.06, "square")],
  victory: [tone(523, 130, 0.07), tone(659, 130, 0.07, "sine", undefined, 120), tone(784, 300, 0.075, "sine", undefined, 240)],
  defeat: [tone(260, 180, 0.07, "triangle", 210), tone(160, 360, 0.07, "triangle", 80, 150)],
  draw: [tone(392, 180, 0.06, "triangle"), tone(392, 250, 0.05, "sine", 350, 170)],
};
