import { CUE_DEFINITIONS, type AudioCue, type CueTone } from "./cues";

export interface AudioEngineOptions {
  readonly contextFactory?: () => AudioContext;
}

export interface PlayCueOptions {
  readonly pan?: number;
  readonly gain?: number;
}

export class AudioEngine {
  readonly #contextFactory: () => AudioContext;
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #muted = false;
  #volume = 0.8;

  constructor(options: AudioEngineOptions = {}) {
    this.#contextFactory =
      options.contextFactory ?? (() => new AudioContext({ latencyHint: "interactive" }));
  }

  get unlocked(): boolean {
    return this.#context !== null;
  }

  async unlock(): Promise<boolean> {
    if (this.#context === null) {
      try {
        this.#context = this.#contextFactory();
        this.#master = this.#context.createGain();
        this.#master.connect(this.#context.destination);
        this.#applyVolume();
      } catch {
        this.#context = null;
        this.#master = null;
        return false;
      }
    }
    if (this.#context.state === "suspended") await this.#context.resume();
    return this.#context.state === "running";
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#applyVolume();
  }

  setVolume(volume: number): void {
    this.#volume = Math.max(0, Math.min(1, volume));
    this.#applyVolume();
  }

  play(cue: AudioCue, options: PlayCueOptions = {}): void {
    const context = this.#context;
    const master = this.#master;
    if (context === null || master === null || context.state !== "running") return;
    const pan = Math.max(-1, Math.min(1, options.pan ?? 0));
    const cueGain = Math.max(0, Math.min(2, options.gain ?? 1));
    for (const tone of CUE_DEFINITIONS[cue]) {
      this.#scheduleTone(context, master, tone, pan, cueGain);
    }
  }

  async dispose(): Promise<void> {
    const context = this.#context;
    this.#context = null;
    this.#master = null;
    if (context !== null && context.state !== "closed") await context.close();
  }

  #applyVolume(): void {
    if (this.#context === null || this.#master === null) return;
    const value = this.#muted ? 0 : this.#volume;
    this.#master.gain.setTargetAtTime(value, this.#context.currentTime, 0.01);
  }

  #scheduleTone(
    context: AudioContext,
    master: GainNode,
    tone: CueTone,
    pan: number,
    cueGain: number,
  ): void {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const panner = context.createStereoPanner();
    const startsAt = context.currentTime + (tone.delayMs ?? 0) / 1_000;
    const endsAt = startsAt + tone.durationMs / 1_000;
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.frequency, startsAt);
    if (tone.endFrequency !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(1, tone.endFrequency),
        endsAt,
      );
    }
    panner.pan.setValueAtTime(pan, startsAt);
    envelope.gain.setValueAtTime(0.0001, startsAt);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, tone.gain * cueGain),
      startsAt + Math.min(0.018, tone.durationMs / 4_000),
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, endsAt);
    oscillator.connect(envelope).connect(panner).connect(master);
    oscillator.start(startsAt);
    oscillator.stop(endsAt + 0.01);
  }
}
