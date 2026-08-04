import {
  CUE_DEFINITIONS,
  GLITCH_PREVIEW_STEP_MS,
  garbageRiseCueForRows,
  type AudioCue,
  type CueDefinition,
  type CueTone,
} from "./cues";
import { ModReplay } from "./mod-replay";
import {
  selectTrackForMatch,
  type ModuleTrack,
  type MusicIntensity,
} from "./music";

export type ModuleLoader = (assetUrl: string) => Promise<ArrayBuffer>;

export interface AudioEngineOptions {
  readonly contextFactory?: () => AudioContext;
  readonly moduleLoader?: ModuleLoader;
}

export interface PlayCueOptions {
  readonly pan?: number;
  readonly gain?: number;
}

export interface GlitchPreviewLoopOptions extends PlayCueOptions {
  /** Elapsed visual-cycle time, used to join an already-running preview in phase. */
  readonly elapsedMs?: number;
}

const DEFAULT_MUSIC_SAMPLE_RATE = 44_100;
const MUSIC_CHUNK_SAMPLES = 8_192;
const MUSIC_LEAD_SECONDS = 0.025;
const MUSIC_SCHEDULE_AHEAD_SECONDS = 0.38;

const fetchModule: ModuleLoader = async (assetUrl) => {
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`Cannot load music module (${response.status}): ${assetUrl}`);
  }
  return response.arrayBuffer();
};

export class AudioEngine {
  readonly #contextFactory: () => AudioContext;
  readonly #moduleLoader: ModuleLoader;
  readonly #moduleCache = new Map<string, Promise<ArrayBuffer>>();
  #context: AudioContext | null = null;
  #effectsBus: GainNode | null = null;
  #musicBus: GainNode | null = null;
  #effectsMuted = false;
  #effectsVolume = 0.8;
  #musicMuted = false;
  #musicVolume = 0.55;
  #musicMix = 1;
  #musicTrack: ModuleTrack | null = null;
  #musicReplay: ModReplay | null = null;
  #musicLoadGeneration = 0;
  #musicScheduledUntilSeconds = 0;
  #musicAnchorTimeSeconds: number | null = null;
  #musicAnchorSample = 0;
  #musicPaused = false;
  #musicResumeRequested = false;
  readonly #musicSources = new Set<AudioBufferSourceNode>();
  #glitchPreviewTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AudioEngineOptions = {}) {
    this.#contextFactory =
      options.contextFactory ?? (() => new AudioContext({ latencyHint: "interactive" }));
    this.#moduleLoader = options.moduleLoader ?? fetchModule;
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
    if (running && this.#musicResumeRequested) this.#resumeModuleMusic();
    return running;
  }

  setMuted(muted: boolean): void {
    this.setEffectsMuted(muted);
  }

  setVolume(volume: number): void {
    this.setEffectsVolume(volume);
  }

  setEffectsMuted(muted: boolean): void {
    if (muted) this.stopGlitchPreviewLoop();
    this.#effectsMuted = muted;
    this.#applyEffectsVolume();
  }

  setEffectsVolume(volume: number): void {
    this.#effectsVolume = Math.max(0, Math.min(1, volume));
    this.#applyEffectsVolume();
  }

  setMusicMuted(muted: boolean): void {
    if (muted && !this.#musicMuted && !this.#musicPaused) {
      this.#haltScheduledMusic();
    }
    this.#musicMuted = muted;
    this.#applyMusicVolume();
  }

  setMusicVolume(volume: number): void {
    this.#musicVolume = Math.max(0, Math.min(1, volume));
    this.#applyMusicVolume();
  }

  play(cue: AudioCue, options: PlayCueOptions = {}): void {
    this.#playDefinition(CUE_DEFINITIONS[cue], options);
  }

  playGarbageRise(rowCount: number, options: PlayCueOptions = {}): void {
    this.#playDefinition(garbageRiseCueForRows(rowCount), options);
  }

  playGlitchPreviewStep(step: number, options: PlayCueOptions = {}): void {
    const gain = Math.max(0, Math.min(2, options.gain ?? 1)) * 0.68;
    this.play(step % 2 === 0 ? "glitch-preview-low" : "glitch-preview-high", {
      ...options,
      gain,
    });
  }

  startGlitchPreviewLoop(options: GlitchPreviewLoopOptions = {}): boolean {
    if (this.#glitchPreviewTimer !== null) return true;
    if (
      this.#effectsMuted ||
      this.#context === null ||
      this.#effectsBus === null ||
      this.#context.state !== "running"
    ) {
      return false;
    }
    const elapsedMs = Number.isFinite(options.elapsedMs)
      ? Math.max(0, options.elapsedMs ?? 0)
      : 0;
    const playOptions: PlayCueOptions = options;
    let step = Math.floor(elapsedMs / GLITCH_PREVIEW_STEP_MS);
    const phaseMs = elapsedMs % GLITCH_PREVIEW_STEP_MS;
    if (phaseMs === 0) this.playGlitchPreviewStep(step, playOptions);
    const untilNextStepMs = phaseMs === 0
      ? GLITCH_PREVIEW_STEP_MS
      : GLITCH_PREVIEW_STEP_MS - phaseMs;
    this.#glitchPreviewTimer = setTimeout(() => {
      step += 1;
      this.playGlitchPreviewStep(step, playOptions);
      this.#glitchPreviewTimer = setInterval(() => {
        step += 1;
        this.playGlitchPreviewStep(step, playOptions);
      }, GLITCH_PREVIEW_STEP_MS);
    }, untilNextStepMs);
    return true;
  }

  stopGlitchPreviewLoop(): void {
    if (this.#glitchPreviewTimer === null) return;
    clearTimeout(this.#glitchPreviewTimer);
    this.#glitchPreviewTimer = null;
  }

  startMusic(matchSeed: string, rematchIndex = 0): ModuleTrack {
    this.stopMusic();
    this.#musicMix = 1;
    const track = selectTrackForMatch(matchSeed, rematchIndex);
    const generation = ++this.#musicLoadGeneration;
    this.#musicTrack = track;
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#applyMusicVolume();
    void this.#loadMusic(track, generation);
    return track;
  }

  startMenuMusic(): ModuleTrack {
    const track = this.startMusic("split-stack-menu", 0);
    this.#musicMix = 0.42;
    this.#applyMusicVolume();
    return track;
  }

  updateMusic(_intensity: MusicIntensity = "calm"): void {
    const context = this.#context;
    const musicBus = this.#musicBus;
    const replay = this.#musicReplay;
    if (
      context === null ||
      musicBus === null ||
      replay === null ||
      this.#musicMuted ||
      context.state !== "running" ||
      this.#musicPaused
    ) {
      return;
    }

    const now = context.currentTime;
    if (this.#musicScheduledUntilSeconds <= now) {
      this.#musicScheduledUntilSeconds = now + MUSIC_LEAD_SECONDS;
      this.#musicAnchorTimeSeconds = this.#musicScheduledUntilSeconds;
      this.#musicAnchorSample = replay.positionSamples;
    }
    const horizon = now + MUSIC_SCHEDULE_AHEAD_SECONDS;
    while (this.#musicScheduledUntilSeconds < horizon) {
      this.#scheduleMusicChunk(
        context,
        musicBus,
        replay,
        this.#musicScheduledUntilSeconds,
      );
      this.#musicScheduledUntilSeconds += MUSIC_CHUNK_SAMPLES / replay.samplingRate;
    }
  }

  pauseMusic(): void {
    if (this.#musicTrack === null || this.#musicPaused) return;
    this.#haltScheduledMusic();
    this.#musicPaused = true;
    this.#musicResumeRequested = false;
    this.#applyMusicVolume();
  }

  resumeMusic(): void {
    const context = this.#context;
    if (this.#musicTrack === null || !this.#musicPaused) return;
    this.#musicResumeRequested = true;
    if (context !== null && context.state === "running") {
      this.#resumeModuleMusic();
      return;
    }
    void this.unlock();
  }

  stopMusic(): void {
    this.#musicLoadGeneration += 1;
    this.#musicTrack = null;
    this.#musicReplay = null;
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#musicScheduledUntilSeconds = 0;
    this.#musicAnchorTimeSeconds = null;
    this.#musicAnchorSample = 0;
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
    this.stopGlitchPreviewLoop();
    this.stopMusic();
    this.#context = null;
    this.#effectsBus = null;
    this.#musicBus = null;
    this.#moduleCache.clear();
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

  async #loadMusic(track: ModuleTrack, generation: number): Promise<void> {
    try {
      const data = await this.#loadModule(track.assetUrl);
      if (
        generation !== this.#musicLoadGeneration ||
        this.#musicTrack?.id !== track.id
      ) {
        return;
      }
      const samplingRate = this.#context?.sampleRate ?? DEFAULT_MUSIC_SAMPLE_RATE;
      this.#musicReplay = new ModReplay(data, samplingRate);
      this.#musicScheduledUntilSeconds = 0;
      this.#musicAnchorTimeSeconds = null;
    } catch {
      // Music is optional. Effects and gameplay remain available if a module
      // cannot be fetched or decoded on a particular host.
      if (generation === this.#musicLoadGeneration) this.#musicReplay = null;
    }
  }

  #loadModule(assetUrl: string): Promise<ArrayBuffer> {
    const cached = this.#moduleCache.get(assetUrl);
    if (cached !== undefined) return cached;
    const pending = this.#moduleLoader(assetUrl).catch((error: unknown) => {
      this.#moduleCache.delete(assetUrl);
      throw error;
    });
    this.#moduleCache.set(assetUrl, pending);
    return pending;
  }

  #resumeModuleMusic(): void {
    const context = this.#context;
    if (
      context === null ||
      context.state !== "running" ||
      this.#musicTrack === null ||
      !this.#musicPaused ||
      !this.#musicResumeRequested
    ) {
      return;
    }
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#musicScheduledUntilSeconds = 0;
    this.#musicAnchorTimeSeconds = null;
    this.#applyMusicVolume();
  }

  #haltScheduledMusic(): void {
    const context = this.#context;
    const replay = this.#musicReplay;
    const anchorTime = this.#musicAnchorTimeSeconds;
    if (context !== null && replay !== null && anchorTime !== null) {
      const audibleUntil = Math.min(
        Math.max(context.currentTime, anchorTime),
        this.#musicScheduledUntilSeconds,
      );
      const elapsedSamples = Math.max(
        0,
        Math.round((audibleUntil - anchorTime) * replay.samplingRate),
      );
      replay.seek(
        (this.#musicAnchorSample + elapsedSamples) % replay.durationSamples,
      );
    }
    this.#stopMusicSources();
    this.#musicScheduledUntilSeconds = 0;
    this.#musicAnchorTimeSeconds = null;
  }

  #playDefinition(
    definition: CueDefinition,
    options: PlayCueOptions,
  ): void {
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
    for (const cueTone of definition) {
      this.#scheduleTone(context, effectsBus, cueTone, pan, cueGain);
    }
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

  #scheduleMusicChunk(
    context: AudioContext,
    musicBus: GainNode,
    replay: ModReplay,
    startsAt: number,
  ): void {
    const left = new Float32Array(MUSIC_CHUNK_SAMPLES);
    const right = new Float32Array(MUSIC_CHUNK_SAMPLES);
    replay.render(left, right);
    const buffer = context.createBuffer(
      2,
      MUSIC_CHUNK_SAMPLES,
      replay.samplingRate,
    );
    buffer.getChannelData(0).set(left);
    buffer.getChannelData(1).set(right);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(musicBus);
    this.#musicSources.add(source);
    source.onended = () => this.#musicSources.delete(source);
    source.start(startsAt);
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
