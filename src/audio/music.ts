export type MusicTrackId = "mountain-king" | "bumblebee" | "kalinka";
export type MusicIntensity = "calm" | "building" | "danger";
export type MusicChannel = "pulse-1" | "pulse-2" | "triangle" | "noise";
export type MusicLayer = "base" | "building" | "danger";

interface ScoreNote {
  readonly beat: number;
  readonly durationBeats: number;
  readonly midi: number;
  readonly channel: MusicChannel;
  readonly layer: MusicLayer;
  readonly gain: number;
}

export interface ProceduralTrack {
  readonly id: MusicTrackId;
  readonly title: string;
  readonly composer: string;
  readonly bpm: number;
  readonly beatsPerLoop: number;
  readonly score: readonly ScoreNote[];
}

const melody = (
  notes: readonly number[],
  step: number,
  repeatShift: number,
): ScoreNote[] => {
  const phraseBeats = notes.length * step;
  return [0, 1].flatMap((repeat) =>
    notes.map((midi, index) => ({
      beat: repeat * phraseBeats + index * step,
      durationBeats: step * 0.82,
      midi: midi + repeat * repeatShift,
      channel: "pulse-1" as const,
      layer: "base" as const,
      gain: 0.075,
    })),
  );
};

const timedMelody = (
  notes: ReadonlyArray<readonly [midi: number, durationBeats: number]>,
): ScoreNote[] => {
  const phraseBeats = notes.reduce((total, [, duration]) => total + duration, 0);
  return [0, 1].flatMap((repeat) => {
    let cursor = repeat * phraseBeats;
    return notes.map(([midi, durationBeats]) => {
      const note: ScoreNote = {
        beat: cursor,
        durationBeats: durationBeats * 0.86,
        midi,
        channel: "pulse-1",
        layer: "base",
        gain: 0.075,
      };
      cursor += durationBeats;
      return note;
    });
  });
};

const accompaniment = (roots: readonly number[]): ScoreNote[] => {
  const notes: ScoreNote[] = [];
  for (let beat = 0; beat < 32; beat += 2) {
    const root = roots[(beat / 2) % roots.length] ?? roots[0] ?? 36;
    notes.push({
      beat,
      durationBeats: 1.65,
      midi: root,
      channel: "triangle",
      layer: "base",
      gain: 0.085,
    });
    notes.push({
      beat: beat + 0.5,
      durationBeats: 0.3,
      midi: root + 12,
      channel: "pulse-2",
      layer: "building",
      gain: 0.036,
    });
  }
  for (let beat = 0; beat < 32; beat += 1) {
    notes.push({
      beat,
      durationBeats: 0.1,
      midi: beat % 4 === 0 ? 78 : 70,
      channel: "noise",
      layer: "building",
      gain: beat % 4 === 0 ? 0.046 : 0.027,
    });
    notes.push({
      beat: beat + 0.5,
      durationBeats: 0.12,
      midi: 84,
      channel: "noise",
      layer: "danger",
      gain: 0.032,
    });
    notes.push({
      beat: beat + 0.75,
      durationBeats: 0.16,
      midi: 88,
      channel: "pulse-2",
      layer: "danger",
      gain: 0.025,
    });
  }
  return notes;
};

const mountainKingScore = [
  ...melody(
    [
      62, 63, 65, 67, 69, 65, 69, 70, 67, 63, 67, 69, 65, 62, 65, 67,
      62, 63, 65, 67, 69, 65, 69, 74, 72, 69, 65, 69, 74, 72, 70, 69,
    ],
    0.5,
    0,
  ),
  ...accompaniment([38, 38, 41, 38, 43, 41, 38, 37]),
];

const bumblebeePhrase = Array.from({ length: 64 }, (_, index) => {
  const descent = index % 16;
  const base = 81 - descent;
  return base + (Math.floor(index / 16) % 2 === 0 ? 0 : 3);
});
const bumblebeeScore = [
  ...melody(bumblebeePhrase, 0.25, -5),
  ...accompaniment([45, 40, 45, 41, 38, 43, 40, 44]),
];

const kalinkaScore = [
  ...timedMelody(
    [
      [71, 1],
      [69, 1], [66, 0.5], [67, 0.5],
      [69, 1], [66, 0.5], [67, 0.5],
      [69, 1], [67, 0.5], [66, 0.5],
      [64, 1], [71, 0.5], [71, 0.5],
      [69, 0.75], [67, 0.25], [66, 0.5], [67, 0.5],
      [69, 1], [66, 0.5], [67, 0.5],
      [69, 1], [67, 0.5], [66, 0.5],
      [64, 1],
    ],
  ),
  ...accompaniment([36, 43, 36, 43, 41, 43, 36, 43]),
];

export const PROCEDURAL_TRACKS: readonly ProceduralTrack[] = [
  {
    id: "mountain-king",
    title: "In the Hall of the Mountain King",
    composer: "Edvard Grieg",
    bpm: 132,
    beatsPerLoop: 32,
    score: mountainKingScore,
  },
  {
    id: "bumblebee",
    title: "Flight of the Bumblebee",
    composer: "Nikolai Rimsky-Korsakov",
    bpm: 148,
    beatsPerLoop: 32,
    score: bumblebeeScore,
  },
  {
    id: "kalinka",
    title: "Kalinka",
    composer: "Ivan Larionov",
    bpm: 126,
    beatsPerLoop: 32,
    score: kalinkaScore,
  },
];

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function selectTrackForMatch(
  matchSeed: string,
  rematchIndex: number,
): ProceduralTrack {
  const offset = Math.max(0, Math.floor(rematchIndex));
  const index = (stableHash(matchSeed) + offset) % PROCEDURAL_TRACKS.length;
  return PROCEDURAL_TRACKS[index] as ProceduralTrack;
}

export interface MusicSequencerOptions {
  readonly matchSeed: string;
  readonly rematchIndex: number;
  readonly startedAtMs?: number;
}

export interface ScheduledMusicEvent {
  readonly atMs: number;
  readonly durationMs: number;
  readonly frequencyHz: number;
  readonly channel: MusicChannel;
  readonly layer: MusicLayer;
  readonly gain: number;
}

const INTENSITY_LEVEL: Readonly<Record<MusicIntensity, number>> = {
  calm: 0,
  building: 1,
  danger: 2,
};

const LAYER_LEVEL: Readonly<Record<MusicLayer, number>> = {
  base: 0,
  building: 1,
  danger: 2,
};

const midiFrequency = (midi: number): number =>
  440 * 2 ** ((midi - 69) / 12);

export class MusicSequencer {
  readonly track: ProceduralTrack;
  #originMs: number;
  #pausedPositionMs: number | null = null;

  constructor(options: MusicSequencerOptions) {
    this.track = selectTrackForMatch(options.matchSeed, options.rematchIndex);
    this.#originMs = options.startedAtMs ?? 0;
  }

  get paused(): boolean {
    return this.#pausedPositionMs !== null;
  }

  positionAt(atMs: number): number {
    return this.#pausedPositionMs ?? Math.max(0, atMs - this.#originMs);
  }

  pause(atMs: number): void {
    if (this.#pausedPositionMs !== null) return;
    this.#pausedPositionMs = this.positionAt(atMs);
  }

  resume(atMs: number): number {
    if (this.#pausedPositionMs === null) return this.positionAt(atMs);
    const beatMs = 60_000 / this.track.bpm;
    const alignedPosition = Math.ceil(this.#pausedPositionMs / beatMs) * beatMs;
    this.#originMs = atMs - alignedPosition;
    this.#pausedPositionMs = null;
    return alignedPosition;
  }

  eventsBetween(
    fromMs: number,
    untilMs: number,
    intensity: MusicIntensity,
  ): ScheduledMusicEvent[] {
    if (untilMs <= fromMs || this.#pausedPositionMs !== null) return [];
    const beatMs = 60_000 / this.track.bpm;
    const loopMs = beatMs * this.track.beatsPerLoop;
    const firstLoop = Math.floor((fromMs - this.#originMs) / loopMs) - 1;
    const lastLoop = Math.ceil((untilMs - this.#originMs) / loopMs);
    const allowedLevel = INTENSITY_LEVEL[intensity];
    const events: ScheduledMusicEvent[] = [];
    for (let loop = Math.max(0, firstLoop); loop <= lastLoop; loop += 1) {
      const loopStartsAt = this.#originMs + loop * loopMs;
      for (const note of this.track.score) {
        if (LAYER_LEVEL[note.layer] > allowedLevel) continue;
        const atMs = loopStartsAt + note.beat * beatMs;
        if (atMs < fromMs || atMs >= untilMs) continue;
        events.push({
          atMs,
          durationMs: note.durationBeats * beatMs,
          frequencyHz: midiFrequency(note.midi),
          channel: note.channel,
          layer: note.layer,
          gain: note.gain,
        });
      }
    }
    return events.sort((left, right) => left.atMs - right.atMs);
  }
}
