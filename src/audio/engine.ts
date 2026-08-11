import {
  CALLOUT_ASSETS,
  CALLOUT_DEFINITIONS,
  CUE_DEFINITIONS,
  CUE_POLICIES,
  GLITCH_PREVIEW_STEP_MS,
  garbageRiseCueForRows,
  type AudioCue,
  type CalloutAsset,
  type CalloutCue,
  type CueDefinition,
  type CueTone,
} from "./cues";
import { ModReplay } from "./mod-replay";
import {
  musicProgramForMatch,
  type ModuleTrack,
  type MusicIntensity,
  type MusicProgram,
} from "./music";

export type ModuleLoader = (assetUrl: string) => Promise<ArrayBuffer>;
export type CalloutLoader = (assetUrl: string) => Promise<ArrayBuffer>;

export interface AudioEngineOptions {
  readonly contextFactory?: () => AudioContext;
  readonly moduleLoader?: ModuleLoader;
  readonly calloutLoader?: CalloutLoader;
}

export interface PlayCueOptions {
  readonly pan?: number;
  readonly gain?: number;
}

export interface PlayCalloutOptions extends PlayCueOptions {
  readonly delayMs?: number;
}

export interface GlitchPreviewLoopOptions extends PlayCueOptions {
  /** Elapsed visual-cycle time, used to join an already-running preview in phase. */
  readonly elapsedMs?: number;
}

const DEFAULT_MUSIC_SAMPLE_RATE = 44_100;
const MUSIC_CHUNK_SAMPLES = 8_192;
const MUSIC_LEAD_SECONDS = 0.025;
const MUSIC_SCHEDULE_AHEAD_SECONDS = 0.85;
const MUSIC_SCHEDULER_INTERVAL_MS = 100;
const EFFECTS_MAKEUP_GAIN = 6;
const CALLOUTS_MAKEUP_GAIN = 4;
const EFFECTS_LIMIT = 0.8;
const EFFECTS_LIMITER_CURVE_SIZE = 2_049;
const MAX_ACTIVE_SFX_TONES = 24;
const MASTER_LIMIT = 0.95;

interface ActiveTone {
  readonly oscillator: OscillatorNode;
  readonly envelope: GainNode;
  readonly panner: StereoPannerNode;
  readonly priority: number;
}

interface ActiveCalloutSample {
  readonly source: AudioBufferSourceNode;
  readonly envelope: GainNode;
  readonly panner: StereoPannerNode;
}

interface CalloutRequest {
  readonly cue: CalloutCue;
  readonly options: PlayCueOptions;
  readonly notBeforeMs: number;
}

function effectsLimiterCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(
    new ArrayBuffer(EFFECTS_LIMITER_CURVE_SIZE * Float32Array.BYTES_PER_ELEMENT),
  );
  for (let index = 0; index < curve.length; index += 1) {
    const input = index / (curve.length - 1) * 2 - 1;
    curve[index] = EFFECTS_LIMIT * Math.tanh(input / EFFECTS_LIMIT);
  }
  return curve;
}

function masterLimiterCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(
    new ArrayBuffer(EFFECTS_LIMITER_CURVE_SIZE * Float32Array.BYTES_PER_ELEMENT),
  );
  for (let index = 0; index < curve.length; index += 1) {
    const input = index / (curve.length - 1) * 2 - 1;
    curve[index] = Math.max(-MASTER_LIMIT, Math.min(MASTER_LIMIT, input));
  }
  return curve;
}

function disconnectNode(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // Cleanup is best-effort when a host has already retired the audio graph.
  }
}

const fetchModule: ModuleLoader = async (assetUrl) => {
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`Cannot load music module (${response.status}): ${assetUrl}`);
  }
  return response.arrayBuffer();
};

const fetchCallout: CalloutLoader = async (assetUrl) => {
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`Cannot load callout (${response.status}): ${assetUrl}`);
  }
  return response.arrayBuffer();
};

export class AudioEngine {
  readonly #contextFactory: () => AudioContext;
  readonly #moduleLoader: ModuleLoader;
  readonly #calloutLoader: CalloutLoader;
  readonly #moduleCache = new Map<string, Promise<ArrayBuffer>>();
  readonly #calloutBufferCache = new Map<string, Promise<AudioBuffer>>();
  #context: AudioContext | null = null;
  #effectsBus: GainNode | null = null;
  #effectsMakeup: GainNode | null = null;
  #effectsLimiter: WaveShaperNode | null = null;
  #masterLimiter: WaveShaperNode | null = null;
  #musicBus: GainNode | null = null;
  #calloutsBus: GainNode | null = null;
  #calloutsMakeup: GainNode | null = null;
  #effectsMuted = false;
  #effectsVolume = 0.8;
  #musicMuted = false;
  #musicVolume = 0.55;
  #calloutsMuted = false;
  #calloutsVolume = 0.8;
  #musicMix = 1;
  #musicTrack: ModuleTrack | null = null;
  #musicProgram: MusicProgram | null = null;
  #musicReplay: ModReplay | null = null;
  #musicLoadGeneration = 0;
  #musicScheduledUntilSeconds = 0;
  #musicAnchorTimeSeconds: number | null = null;
  #musicAnchorSample = 0;
  #musicPaused = false;
  #musicResumeRequested = false;
  readonly #musicSources = new Set<AudioBufferSourceNode>();
  #musicSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  readonly #activeSfxTones = new Set<ActiveTone>();
  readonly #activeCalloutTones = new Set<ActiveTone>();
  readonly #activeCalloutSamples = new Set<ActiveCalloutSample>();
  readonly #lastSfxAt = new Map<AudioCue, number>();
  #activeCallout: CalloutRequest | null = null;
  readonly #pendingCallouts: CalloutRequest[] = [];
  #calloutTimer: ReturnType<typeof setTimeout> | null = null;
  #calloutOverflowCount = 0;
  #glitchPreviewTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AudioEngineOptions = {}) {
    this.#contextFactory =
      options.contextFactory ?? (() => new AudioContext({ latencyHint: "interactive" }));
    this.#moduleLoader = options.moduleLoader ?? fetchModule;
    this.#calloutLoader = options.calloutLoader ?? fetchCallout;
  }

  get unlocked(): boolean {
    return this.#context !== null;
  }

  async unlock(): Promise<boolean> {
    if (this.#context === null) {
      try {
        this.#context = this.#contextFactory();
        this.#effectsBus = this.#context.createGain();
        this.#effectsMakeup = this.#context.createGain();
        this.#effectsLimiter = this.#context.createWaveShaper();
        this.#masterLimiter = this.#context.createWaveShaper();
        this.#musicBus = this.#context.createGain();
        this.#calloutsBus = this.#context.createGain();
        this.#calloutsMakeup = this.#context.createGain();
        this.#effectsMakeup.gain.setValueAtTime(
          EFFECTS_MAKEUP_GAIN,
          this.#context.currentTime,
        );
        this.#calloutsMakeup.gain.setValueAtTime(
          CALLOUTS_MAKEUP_GAIN,
          this.#context.currentTime,
        );
        this.#effectsLimiter.curve = effectsLimiterCurve();
        this.#effectsLimiter.oversample = "4x";
        this.#masterLimiter.curve = masterLimiterCurve();
        this.#masterLimiter.oversample = "4x";
        this.#effectsMakeup
          .connect(this.#effectsLimiter)
          .connect(this.#effectsBus)
          .connect(this.#masterLimiter);
        this.#musicBus.connect(this.#masterLimiter);
        this.#calloutsMakeup.connect(this.#calloutsBus).connect(this.#masterLimiter);
        this.#masterLimiter.connect(this.#context.destination);
        this.#applyEffectsVolume();
        this.#applyMusicVolume();
        this.#applyCalloutsVolume();
        this.#preloadCalloutAssets();
      } catch {
        this.#context = null;
        this.#effectsBus = null;
        this.#effectsMakeup = null;
        this.#effectsLimiter = null;
        this.#masterLimiter = null;
        this.#musicBus = null;
        this.#calloutsBus = null;
        this.#calloutsMakeup = null;
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
      this.#stopMusicScheduler();
      this.#haltScheduledMusic();
    }
    this.#musicMuted = muted;
    this.#applyMusicVolume();
    if (!muted) this.#startMusicScheduler();
  }

  setMusicVolume(volume: number): void {
    this.#musicVolume = Math.max(0, Math.min(1, volume));
    this.#applyMusicVolume();
  }

  setCalloutsMuted(muted: boolean): void {
    if (muted) this.clearCallouts();
    this.#calloutsMuted = muted;
    this.#applyCalloutsVolume();
  }

  setCalloutsVolume(volume: number): void {
    this.#calloutsVolume = Math.max(0, Math.min(1, volume));
    this.#applyCalloutsVolume();
  }

  play(cue: AudioCue, options: PlayCueOptions = {}): void {
    const context = this.#context;
    if (
      this.#effectsMuted ||
      context === null ||
      this.#effectsMakeup === null ||
      context.state !== "running"
    ) {
      return;
    }
    const policy = CUE_POLICIES[cue] ?? { priority: 2, retriggerMs: 0 };
    if (policy.retriggerMs > 0) {
      const last = this.#lastSfxAt.get(cue);
      if (last !== undefined && context.currentTime - last < policy.retriggerMs / 1_000) {
        return;
      }
      this.#lastSfxAt.set(cue, context.currentTime);
    }
    this.#playDefinition(
      CUE_DEFINITIONS[cue],
      options,
      this.#effectsMakeup,
      this.#effectsMuted,
      policy.priority,
    );
  }

  playCallout(cue: CalloutCue, options: PlayCalloutOptions = {}): void {
    const context = this.#context;
    if (
      this.#calloutsMuted ||
      context === null ||
      this.#calloutsMakeup === null ||
      context.state !== "running"
    ) {
      return;
    }
    const delayMs = Number.isFinite(options.delayMs)
      ? Math.max(0, options.delayMs ?? 0)
      : 0;
    const request: CalloutRequest = {
      cue,
      options,
      notBeforeMs: Date.now() + delayMs,
    };
    if (this.#activeCallout === null) {
      this.#activateCallout(request);
      return;
    }
    if (this.#pendingCallouts.length >= 3) {
      const oldestCombo = this.#pendingCallouts.findIndex((pending) =>
        pending.cue.startsWith("combo-")
      );
      this.#pendingCallouts.splice(oldestCombo >= 0 ? oldestCombo : 0, 1);
      this.#calloutOverflowCount += 1;
    }
    this.#pendingCallouts.push(request);
  }

  clearCallouts(): void {
    if (this.#calloutTimer !== null) clearTimeout(this.#calloutTimer);
    this.#calloutTimer = null;
    this.#activeCallout = null;
    this.#pendingCallouts.length = 0;
    for (const active of [...this.#activeCalloutTones]) {
      this.#finishTone(active, true);
    }
    for (const active of [...this.#activeCalloutSamples]) {
      this.#finishCalloutSample(active, true);
    }
  }

  playGarbageRise(rowCount: number, options: PlayCueOptions = {}): void {
    this.#playDefinition(
      garbageRiseCueForRows(rowCount),
      options,
      this.#effectsMakeup,
      this.#effectsMuted,
      2,
    );
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
    return this.startMusicProgram(musicProgramForMatch(matchSeed, rematchIndex));
  }

  startMusicProgram(program: MusicProgram): ModuleTrack {
    this.stopMusic();
    this.#musicMix = 1;
    const track = program.tracks[0];
    const generation = ++this.#musicLoadGeneration;
    this.#musicProgram = program;
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
    this.clearCallouts();
    if (this.#musicTrack === null || this.#musicPaused) return;
    this.#stopMusicScheduler();
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
    this.clearCallouts();
    this.#stopMusicScheduler();
    this.#musicLoadGeneration += 1;
    this.#musicProgram = null;
    this.#musicTrack = null;
    this.#musicReplay = null;
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#musicScheduledUntilSeconds = 0;
    this.#musicAnchorTimeSeconds = null;
    this.#musicAnchorSample = 0;
    this.#stopMusicSources();
  }

  duckMusic(durationMs = 350, amount = 0.68): void {
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
    this.clearCallouts();
    this.stopMusic();
    this.#context = null;
    this.#effectsBus = null;
    this.#effectsMakeup = null;
    this.#effectsLimiter = null;
    this.#masterLimiter = null;
    this.#musicBus = null;
    this.#calloutsBus = null;
    this.#calloutsMakeup = null;
    for (const active of [...this.#activeSfxTones]) this.#finishTone(active, true);
    this.#lastSfxAt.clear();
    this.#moduleCache.clear();
    this.#calloutBufferCache.clear();
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

  #applyCalloutsVolume(): void {
    if (this.#context === null || this.#calloutsBus === null) return;
    const value = this.#calloutsMuted ? 0 : this.#calloutsVolume;
    this.#calloutsBus.gain.cancelScheduledValues(this.#context.currentTime);
    this.#calloutsBus.gain.setTargetAtTime(value, this.#context.currentTime, 0.01);
  }

  #preloadCalloutAssets(): void {
    for (const asset of Object.values(CALLOUT_ASSETS)) {
      if (asset === undefined) continue;
      void this.#loadCalloutBuffer(asset.assetUrl).catch(() => {
        // Recorded callouts are optional; playback retains a procedural fallback.
      });
    }
  }

  #loadCalloutBuffer(assetUrl: string): Promise<AudioBuffer> {
    const cached = this.#calloutBufferCache.get(assetUrl);
    if (cached !== undefined) return cached;
    const pending = this.#calloutLoader(assetUrl).then((data) => {
      const context = this.#context;
      if (context === null || context.state === "closed") {
        throw new Error(`Cannot decode callout without an active audio context: ${assetUrl}`);
      }
      return context.decodeAudioData(data.slice(0));
    });
    this.#calloutBufferCache.set(assetUrl, pending);
    return pending;
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
      this.#startMusicScheduler();
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
    this.#startMusicScheduler();
  }

  #startMusicScheduler(): void {
    const context = this.#context;
    if (
      this.#musicSchedulerTimer !== null ||
      context === null ||
      context.state !== "running" ||
      this.#musicReplay === null ||
      this.#musicMuted ||
      this.#musicPaused
    ) {
      return;
    }
    this.updateMusic();
    this.#musicSchedulerTimer = setInterval(
      () => this.updateMusic(),
      MUSIC_SCHEDULER_INTERVAL_MS,
    );
  }

  #stopMusicScheduler(): void {
    if (this.#musicSchedulerTimer === null) return;
    clearInterval(this.#musicSchedulerTimer);
    this.#musicSchedulerTimer = null;
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
    input: GainNode | null,
    muted: boolean,
    priority: number | null,
  ): void {
    const context = this.#context;
    if (
      muted ||
      context === null ||
      input === null ||
      context.state !== "running"
    ) {
      return;
    }
    const pan = Math.max(-1, Math.min(1, options.pan ?? 0));
    const cueGain = Math.max(0, Math.min(2, options.gain ?? 1));
    for (const cueTone of definition) {
      if (priority !== null && !this.#reserveSfxTone(priority)) continue;
      this.#scheduleTone(context, input, cueTone, pan, cueGain, priority);
    }
  }

  #activateCallout(request: CalloutRequest): void {
    this.#activeCallout = request;
    const waitMs = Math.max(0, request.notBeforeMs - Date.now());
    if (waitMs > 0) {
      this.#calloutTimer = setTimeout(() => this.#startActiveCallout(), waitMs);
      return;
    }
    this.#startActiveCallout();
  }

  #startActiveCallout(): void {
    this.#calloutTimer = null;
    const active = this.#activeCallout;
    if (active === null) return;
    const asset = CALLOUT_ASSETS[active.cue];
    if (asset !== undefined) {
      void this.#startSampleCallout(active, asset);
      return;
    }
    this.#startProceduralCallout(active);
  }

  async #startSampleCallout(
    request: CalloutRequest,
    asset: CalloutAsset,
  ): Promise<void> {
    try {
      const buffer = await this.#loadCalloutBuffer(asset.assetUrl);
      const context = this.#context;
      const calloutsBus = this.#calloutsBus;
      if (
        this.#activeCallout !== request ||
        this.#calloutsMuted ||
        context === null ||
        calloutsBus === null ||
        context.state !== "running"
      ) {
        return;
      }
      this.#scheduleCalloutSample(context, calloutsBus, buffer, request.options);
      const durationMs = Math.max(1, Math.ceil(buffer.duration * 1_000));
      if (asset.ducksMusic) this.duckMusic(durationMs);
      this.#calloutTimer = setTimeout(() => this.#finishActiveCallout(), durationMs);
    } catch {
      if (this.#activeCallout === request) this.#startProceduralCallout(request);
    }
  }

  #startProceduralCallout(active: CalloutRequest): void {
    if (this.#activeCallout !== active) return;
    const definition = CALLOUT_DEFINITIONS[active.cue];
    this.#playDefinition(
      definition,
      active.options,
      this.#calloutsMakeup,
      this.#calloutsMuted,
      null,
    );
    const durationMs = definition.reduce(
      (duration, tone) => Math.max(duration, (tone.delayMs ?? 0) + tone.durationMs),
      0,
    );
    this.#calloutTimer = setTimeout(() => this.#finishActiveCallout(), durationMs);
  }

  #finishActiveCallout(): void {
    this.#calloutTimer = null;
    for (const active of [...this.#activeCalloutTones]) {
      this.#finishTone(active, true);
    }
    for (const active of [...this.#activeCalloutSamples]) {
      this.#finishCalloutSample(active, true);
    }
    this.#activeCallout = null;
    const next = this.#pendingCallouts.shift();
    if (next !== undefined) this.#activateCallout(next);
  }

  #reserveSfxTone(priority: number): boolean {
    if (this.#activeSfxTones.size < MAX_ACTIVE_SFX_TONES) return true;
    let candidate: ActiveTone | null = null;
    for (const active of this.#activeSfxTones) {
      if (candidate === null || active.priority < candidate.priority) candidate = active;
    }
    if (candidate === null || candidate.priority >= priority) return false;
    this.#finishTone(candidate, true);
    return true;
  }

  #scheduleTone(
    context: AudioContext,
    master: GainNode,
    tone: CueTone,
    pan: number,
    cueGain: number,
    priority: number | null,
  ): void {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const panner = context.createStereoPanner();
    const startsAt = context.currentTime + (tone.delayMs ?? 0) / 1_000;
    const endsAt = startsAt + tone.durationMs / 1_000;
    const active: ActiveTone = { oscillator, envelope, panner, priority: priority ?? 0 };
    if (priority !== null) this.#activeSfxTones.add(active);
    else this.#activeCalloutTones.add(active);
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
    oscillator.onended = () => {
      this.#finishTone(active, false);
    };
    oscillator.start(startsAt);
    oscillator.stop(endsAt + 0.01);
  }

  #scheduleCalloutSample(
    context: AudioContext,
    calloutsBus: GainNode,
    buffer: AudioBuffer,
    options: PlayCueOptions,
  ): void {
    const source = context.createBufferSource();
    const envelope = context.createGain();
    const panner = context.createStereoPanner();
    const active: ActiveCalloutSample = { source, envelope, panner };
    const pan = Math.max(-1, Math.min(1, options.pan ?? 0));
    const cueGain = Math.max(0, Math.min(2, options.gain ?? 1));
    source.buffer = buffer;
    panner.pan.setValueAtTime(pan, context.currentTime);
    envelope.gain.setValueAtTime(cueGain, context.currentTime);
    source.connect(envelope).connect(panner).connect(calloutsBus);
    this.#activeCalloutSamples.add(active);
    source.onended = () => this.#finishCalloutSample(active, false);
    source.start(context.currentTime);
  }

  #finishTone(active: ActiveTone, stop: boolean): void {
    if (stop) {
      try {
        active.oscillator.stop();
      } catch {
        // The oscillator may already have ended.
      }
    }
    this.#activeSfxTones.delete(active);
    this.#activeCalloutTones.delete(active);
    disconnectNode(active.oscillator);
    disconnectNode(active.envelope);
    disconnectNode(active.panner);
  }

  #finishCalloutSample(active: ActiveCalloutSample, stop: boolean): void {
    if (stop) {
      try {
        active.source.stop();
      } catch {
        // The sample may already have ended.
      }
    }
    this.#activeCalloutSamples.delete(active);
    disconnectNode(active.source);
    disconnectNode(active.envelope);
    disconnectNode(active.panner);
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
    source.onended = () => {
      this.#musicSources.delete(source);
      disconnectNode(source);
    };
    source.start(startsAt);
  }

  #stopMusicSources(): void {
    for (const source of this.#musicSources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended between scheduling and cleanup.
      }
      disconnectNode(source);
    }
    this.#musicSources.clear();
  }
}
