import { CUE_DEFINITIONS, type AudioCue, type CueTone } from "./cues";
import {
  MusicSequencer,
  type MusicIntensity,
  type ProceduralTrack,
  type ScheduledMusicEvent,
} from "./music";

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
  #effectsBus: GainNode | null = null;
  #musicBus: GainNode | null = null;
  #effectsMuted = false;
  #effectsVolume = 0.8;
  #musicMuted = false;
  #musicVolume = 0.55;
  #musicMix = 1;
  #music: MusicSequencer | null = null;
  #musicIntensity: MusicIntensity = "calm";
  #musicScheduledUntilMs = 0;
  #musicPaused = false;
  #musicResumeRequested = false;
  #noiseBuffer: AudioBuffer | null = null;
  readonly #musicSources = new Set<AudioScheduledSourceNode>();

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
        this.#effectsBus = this.#context.createGain();
        this.#musicBus = this.#context.createGain();
        this.#effectsBus.connect(this.#context.destination);
        this.#musicBus.connect(this.#context.destination);
        this.#applyEffectsVolume();
        this.#applyMusicVolume();
      } catch {
        this.#context = null;
        this.#effectsBus = null;
        this.#musicBus = null;
        return false;
      }
    }
    const contextState = this.#context.state as string;
    if (contextState !== "running" && contextState !== "closed") {
      try {
        await this.#context.resume();
      } catch {
        return false;
      }
    }
    const running = this.#context.state === "running";
    if (running && this.#musicResumeRequested) this.#resumeMusicSequencer();
    return running;
  }

  setMuted(muted: boolean): void {
    this.setEffectsMuted(muted);
  }

  setVolume(volume: number): void {
    this.setEffectsVolume(volume);
  }

  setEffectsMuted(muted: boolean): void {
    this.#effectsMuted = muted;
    this.#applyEffectsVolume();
  }

  setEffectsVolume(volume: number): void {
    this.#effectsVolume = Math.max(0, Math.min(1, volume));
    this.#applyEffectsVolume();
  }

  setMusicMuted(muted: boolean): void {
    this.#musicMuted = muted;
    this.#applyMusicVolume();
  }

  setMusicVolume(volume: number): void {
    this.#musicVolume = Math.max(0, Math.min(1, volume));
    this.#applyMusicVolume();
  }

  play(cue: AudioCue, options: PlayCueOptions = {}): void {
    const context = this.#context;
    const effectsBus = this.#effectsBus;
    if (
      this.#effectsMuted ||
      context === null ||
      effectsBus === null ||
      context.state !== "running"
    ) {
      return;
    }
    const pan = Math.max(-1, Math.min(1, options.pan ?? 0));
    const cueGain = Math.max(0, Math.min(2, options.gain ?? 1));
    for (const tone of CUE_DEFINITIONS[cue]) {
      this.#scheduleTone(context, effectsBus, tone, pan, cueGain);
    }
  }

  startMusic(matchSeed: string, rematchIndex = 0): ProceduralTrack {
    this.stopMusic();
    this.#musicMix = 1;
    const nowMs = (this.#context?.currentTime ?? 0) * 1_000;
    const startedAtMs = nowMs + 40;
    this.#music = new MusicSequencer({ matchSeed, rematchIndex, startedAtMs });
    this.#musicScheduledUntilMs = nowMs;
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#applyMusicVolume();
    return this.#music.track;
  }

  startMenuMusic(): ProceduralTrack {
    const track = this.startMusic("split-stack-menu", 0);
    this.#musicMix = 0.42;
    this.#applyMusicVolume();
    return track;
  }

  updateMusic(intensity: MusicIntensity = this.#musicIntensity): void {
    this.#musicIntensity = intensity;
    const context = this.#context;
    const musicBus = this.#musicBus;
    const music = this.#music;
    if (
      context === null ||
      musicBus === null ||
      music === null ||
      this.#musicMuted ||
      context.state !== "running" ||
      this.#musicPaused
    ) {
      return;
    }
    const nowMs = context.currentTime * 1_000;
    const fromMs = Math.max(nowMs + 12, this.#musicScheduledUntilMs);
    const untilMs = nowMs + 180;
    if (untilMs <= fromMs) return;
    for (const event of music.eventsBetween(fromMs, untilMs, intensity)) {
      this.#scheduleMusicEvent(context, musicBus, event);
    }
    this.#musicScheduledUntilMs = untilMs;
  }

  pauseMusic(): void {
    const context = this.#context;
    if (this.#music === null || this.#musicPaused) return;
    this.#music.pause((context?.currentTime ?? 0) * 1_000);
    this.#musicPaused = true;
    this.#musicResumeRequested = false;
    this.#stopMusicSources();
    this.#applyMusicVolume();
  }

  resumeMusic(): void {
    const context = this.#context;
    if (this.#music === null || !this.#musicPaused) return;
    this.#musicResumeRequested = true;
    if (context !== null && context.state === "running") {
      this.#resumeMusicSequencer();
      return;
    }
    void this.unlock();
  }

  stopMusic(): void {
    this.#music = null;
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#musicScheduledUntilMs = 0;
    this.#stopMusicSources();
  }

  duckMusic(durationMs = 350, amount = 0.45): void {
    const context = this.#context;
    const bus = this.#musicBus;
    if (context === null || bus === null || this.#musicMuted || this.#musicPaused) return;
    const normal = this.#musicVolume * this.#musicMix;
    const ducked = normal * Math.max(0, Math.min(1, amount));
    bus.gain.cancelScheduledValues(context.currentTime);
    bus.gain.setTargetAtTime(ducked, context.currentTime, 0.02);
    bus.gain.setTargetAtTime(normal, context.currentTime + durationMs / 1_000, 0.08);
  }

  async dispose(): Promise<void> {
    const context = this.#context;
    this.stopMusic();
    this.#context = null;
    this.#effectsBus = null;
    this.#musicBus = null;
    this.#noiseBuffer = null;
    if (context !== null && context.state !== "closed") await context.close();
  }

  #applyEffectsVolume(): void {
    if (this.#context === null || this.#effectsBus === null) return;
    const value = this.#effectsMuted ? 0 : this.#effectsVolume;
    this.#effectsBus.gain.cancelScheduledValues(this.#context.currentTime);
    this.#effectsBus.gain.setTargetAtTime(value, this.#context.currentTime, 0.01);
  }

  #applyMusicVolume(): void {
    if (this.#context === null || this.#musicBus === null) return;
    const value = this.#musicMuted || this.#musicPaused
      ? 0
      : this.#musicVolume * this.#musicMix;
    this.#musicBus.gain.cancelScheduledValues(this.#context.currentTime);
    this.#musicBus.gain.setTargetAtTime(value, this.#context.currentTime, 0.02);
  }

  #resumeMusicSequencer(): void {
    const context = this.#context;
    if (
      context === null ||
      context.state !== "running" ||
      this.#music === null ||
      !this.#musicPaused ||
      !this.#musicResumeRequested
    ) {
      return;
    }
    const nowMs = context.currentTime * 1_000;
    this.#music.resume(nowMs + 40);
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#musicScheduledUntilMs = nowMs;
    this.#applyMusicVolume();
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

  #scheduleMusicEvent(
    context: AudioContext,
    musicBus: GainNode,
    event: ScheduledMusicEvent,
  ): void {
    const startsAt = event.atMs / 1_000;
    const endsAt = startsAt + event.durationMs / 1_000;
    const envelope = context.createGain();
    const panner = context.createStereoPanner();
    const pan = event.channel === "pulse-1"
      ? -0.22
      : event.channel === "pulse-2"
        ? 0.22
        : 0;
    panner.pan.setValueAtTime(pan, startsAt);
    envelope.gain.setValueAtTime(0.0001, startsAt);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, event.gain),
      startsAt + 0.008,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, endsAt);

    let source: AudioScheduledSourceNode;
    if (event.channel === "noise") {
      const noise = context.createBufferSource();
      noise.buffer = this.#noiseBufferFor(context);
      noise.loop = true;
      source = noise;
    } else {
      const oscillator = context.createOscillator();
      oscillator.type = event.channel === "triangle" ? "triangle" : "square";
      oscillator.frequency.setValueAtTime(event.frequencyHz, startsAt);
      source = oscillator;
    }
    source.connect(envelope).connect(panner).connect(musicBus);
    this.#musicSources.add(source);
    source.onended = () => this.#musicSources.delete(source);
    source.start(startsAt);
    source.stop(endsAt + 0.01);
  }

  #noiseBufferFor(context: AudioContext): AudioBuffer {
    if (this.#noiseBuffer !== null) return this.#noiseBuffer;
    const length = Math.max(1, Math.floor(context.sampleRate * 0.1));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let register = 0x5a5a;
    for (let index = 0; index < data.length; index += 1) {
      const bit = ((register >> 0) ^ (register >> 1)) & 1;
      register = (register >> 1) | (bit << 14);
      data[index] = (register & 1) === 0 ? -0.72 : 0.72;
    }
    this.#noiseBuffer = buffer;
    return buffer;
  }

  #stopMusicSources(): void {
    for (const source of this.#musicSources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended between scheduling and cleanup.
      }
    }
    this.#musicSources.clear();
  }
}
