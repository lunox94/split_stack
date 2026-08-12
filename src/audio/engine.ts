import {
  CALLOUT_ASSETS,
  CALLOUT_DEFINITIONS,
  CUE_DEFINITIONS,
  CUE_POLICIES,
  GLITCH_PREVIEW_STEP_MS,
  PROCEDURAL_CALLOUT_GAIN,
  garbageRiseCueForRow,
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
import type { GarbageSequencePlan } from "../app/garbage-sequence";

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
const MUSIC_CROSSFADE_SECONDS = 0.8;
const MUSIC_STOP_FADE_MS = 300;
const EFFECTS_MAKEUP_GAIN = 6;
const CALLOUTS_MAKEUP_GAIN = 4.4;
const RECORDED_CALLOUT_GAIN = 1.18;
// A small interpolation margin keeps the oversampled shaper below the 0.8 bus ceiling.
const EFFECTS_LIMIT = 0.795;
const EFFECTS_LIMITER_KNEE = 0.55;
const EFFECTS_LIMITER_CURVE_SIZE = 2_049;
const MAX_ACTIVE_SFX_TONES = 24;
const MASTER_LIMIT = 0.95;

const musicGain = (volume: number): number => volume * volume;
const presenceGain = (volume: number): number => volume ** 1.4;

interface ActiveTone {
  readonly oscillator: OscillatorNode;
  readonly envelope: GainNode;
  readonly panner: StereoPannerNode;
  readonly priority: number;
  readonly startsAt: number;
  readonly endsAt: number;
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

interface MusicDuckRequest {
  readonly amount: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface MusicCursorSnapshot {
  readonly trackIndex: number;
  readonly positionSamples: number;
  readonly transitionTrackIndex: number | null;
  readonly transitionPositionSamples: number;
}

interface MusicRenderSpan extends MusicCursorSnapshot {
  readonly offsetSamples: number;
  readonly lengthSamples: number;
}

interface ScheduledMusicChunk {
  readonly startsAt: number;
  readonly endsAt: number;
  readonly spans: readonly MusicRenderSpan[];
  readonly end: MusicCursorSnapshot;
}

function effectsLimiterCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(
    new ArrayBuffer(EFFECTS_LIMITER_CURVE_SIZE * Float32Array.BYTES_PER_ELEMENT),
  );
  for (let index = 0; index < curve.length; index += 1) {
    const input = index / (curve.length - 1) * 2 - 1;
    const sign = Math.sign(input);
    const magnitude = Math.abs(input);
    if (magnitude <= EFFECTS_LIMITER_KNEE) {
      curve[index] = input;
      continue;
    }
    const span = 1 - EFFECTS_LIMITER_KNEE;
    const t = (magnitude - EFFECTS_LIMITER_KNEE) / span;
    const t2 = t * t;
    const t3 = t2 * t;
    const kneeContribution = (2 * t3 - 3 * t2 + 1) * EFFECTS_LIMITER_KNEE;
    const slopeContribution = (t3 - 2 * t2 + t) * span;
    const limitContribution = (-2 * t3 + 3 * t2) * EFFECTS_LIMIT;
    curve[index] = sign * (
      kneeContribution + slopeContribution + limitContribution
    );
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
  readonly #loadedModules = new Map<string, ArrayBuffer>();
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
  #effectsVolume = 0.85;
  #musicMuted = false;
  #musicVolume = 0.45;
  #calloutsMuted = false;
  #calloutsVolume = 0.85;
  #musicMix = 1;
  #musicTrackIndex = 0;
  #musicTrack: ModuleTrack | null = null;
  #musicProgram: MusicProgram | null = null;
  #musicReplay: ModReplay | null = null;
  #nextMusicTrackIndex: number | null = null;
  #nextMusicReplay: ModReplay | null = null;
  #musicTransitioning = false;
  readonly #failedMusicTracks = new Set<ModuleTrack["id"]>();
  #musicLoadGeneration = 0;
  #musicScheduledUntilSeconds = 0;
  #musicAnchorTimeSeconds: number | null = null;
  #musicPaused = false;
  #musicResumeRequested = false;
  #musicStopping = false;
  readonly #musicSources = new Set<AudioBufferSourceNode>();
  readonly #scheduledMusicChunks: ScheduledMusicChunk[] = [];
  #musicSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  #musicStopTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #activeSfxTones = new Set<ActiveTone>();
  readonly #activeCalloutTones = new Set<ActiveTone>();
  readonly #activeCalloutSamples = new Set<ActiveCalloutSample>();
  readonly #lastSfxAt = new Map<AudioCue, number>();
  #activeCallout: CalloutRequest | null = null;
  readonly #pendingCallouts: CalloutRequest[] = [];
  #calloutTimer: ReturnType<typeof setTimeout> | null = null;
  #calloutOverflowCount = 0;
  #glitchPreviewTimer: ReturnType<typeof setInterval> | null = null;
  readonly #musicDucks = new Map<number, MusicDuckRequest>();
  #musicDuckOrdinal = 0;

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

  stopEffects(): void {
    for (const active of [...this.#activeSfxTones]) this.#finishTone(active, true);
    this.#lastSfxAt.clear();
    this.#clearMusicDucks();
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
      {
        ...options,
        gain: (options.gain ?? 1) * (policy.gain ?? 1),
      },
      this.#effectsMakeup,
      this.#effectsMuted,
      policy.priority,
    );
    if (policy.musicDuck !== undefined) {
      this.duckMusic(policy.musicDuck.durationMs, policy.musicDuck.amount);
    }
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
      options: { ...options, pan: 0 },
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

  playGarbageRise(
    rowCount: number,
    options: PlayCueOptions = {},
    sequence?: GarbageSequencePlan,
  ): void {
    if (!Number.isFinite(rowCount) || rowCount <= 0) return;
    const rows = Math.max(1, Math.min(4, Math.round(rowCount)));
    const impactPan = Math.max(-0.2, Math.min(0.2, options.pan ?? 0));
    const garbageOptions = {
      ...options,
      gain: (options.gain ?? 1) * 1.14,
    };
    const batchDelayMs = sequence === undefined
      ? 0
      : Math.max(0, sequence.startedAtMs - sequence.requestedAtMs);
    let durationMs = 0;
    for (let index = 0; index < rows; index += 1) {
      const cue = garbageRiseCueForRow(
        index,
        rows,
        sequence?.cadence,
        batchDelayMs,
      );
      for (const tone of [...cue.rumble, ...cue.impact]) {
        durationMs = Math.max(durationMs, (tone.delayMs ?? 0) + tone.durationMs);
      }
      this.#playDefinition(
        cue.rumble,
        { ...garbageOptions, pan: 0 },
        this.#effectsMakeup,
        this.#effectsMuted,
        3,
      );
      this.#playDefinition(
        cue.impact,
        { ...garbageOptions, pan: impactPan },
        this.#effectsMakeup,
        this.#effectsMuted,
        3,
      );
    }
    this.duckMusic(durationMs, 0.74);
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
    this.#stopMusicImmediately();
    const track = program.tracks[0];
    const generation = ++this.#musicLoadGeneration;
    this.#musicProgram = program;
    this.#musicMix = 1;
    this.#musicTrackIndex = 0;
    this.#musicTrack = track;
    this.#musicReplay = null;
    this.#nextMusicTrackIndex = null;
    this.#nextMusicReplay = null;
    this.#musicTransitioning = false;
    this.#failedMusicTracks.clear();
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#musicStopping = false;
    this.#applyMusicVolume();
    void this.#loadCurrentMusicTrack(0, generation);
    return track;
  }

  startMenuMusic(): ModuleTrack {
    const track = this.startMusic("split-stack-menu", 0);
    this.#musicMix = track.mixGain * 0.42;
    this.#applyMusicVolume();
    return track;
  }

  updateMusic(_intensity: MusicIntensity = "calm"): void {
    const context = this.#context;
    const musicBus = this.#musicBus;
    if (
      context === null ||
      musicBus === null ||
      this.#musicReplay === null ||
      this.#musicMuted ||
      context.state !== "running" ||
      this.#musicPaused ||
      this.#musicStopping
    ) {
      return;
    }

    const now = context.currentTime;
    while (
      this.#scheduledMusicChunks.length > 0 &&
      this.#scheduledMusicChunks[0]!.endsAt < now
    ) {
      this.#scheduledMusicChunks.shift();
    }
    if (this.#musicScheduledUntilSeconds <= now) {
      this.#musicScheduledUntilSeconds = now + MUSIC_LEAD_SECONDS;
      this.#musicAnchorTimeSeconds = this.#musicScheduledUntilSeconds;
    }
    const horizon = now + MUSIC_SCHEDULE_AHEAD_SECONDS;
    while (this.#musicScheduledUntilSeconds < horizon) {
      this.#scheduleMusicChunk(
        context,
        musicBus,
        this.#musicScheduledUntilSeconds,
      );
      this.#musicScheduledUntilSeconds +=
        MUSIC_CHUNK_SAMPLES / this.#musicReplay.samplingRate;
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
    if (this.#musicStopping) return;
    if (
      this.#musicTrack === null ||
      this.#musicMuted ||
      this.#musicPaused ||
      this.#context === null ||
      this.#musicBus === null
    ) {
      this.#stopMusicImmediately();
      return;
    }
    this.#stopMusicScheduler();
    this.#musicStopping = true;
    this.#applyMusicVolume(0.05);
    this.#musicStopTimer = setTimeout(
      () => this.#stopMusicImmediately(),
      MUSIC_STOP_FADE_MS,
    );
  }

  #stopMusicImmediately(): void {
    this.clearCallouts();
    if (this.#musicStopTimer !== null) clearTimeout(this.#musicStopTimer);
    this.#musicStopTimer = null;
    this.#musicStopping = false;
    this.#musicLoadGeneration += 1;
    this.#musicProgram = null;
    this.#musicTrackIndex = 0;
    this.#musicTrack = null;
    this.#musicReplay = null;
    this.#nextMusicTrackIndex = null;
    this.#nextMusicReplay = null;
    this.#musicTransitioning = false;
    this.#failedMusicTracks.clear();
    this.#musicPaused = false;
    this.#musicResumeRequested = false;
    this.#musicScheduledUntilSeconds = 0;
    this.#musicAnchorTimeSeconds = null;
    this.#stopMusicSources();
    this.#scheduledMusicChunks.length = 0;
    this.#clearMusicDucks();
  }

  duckMusic(durationMs = 350, amount = 0.68): void {
    const context = this.#context;
    const bus = this.#musicBus;
    if (context === null || bus === null || this.#musicMuted || this.#musicPaused) return;
    const id = ++this.#musicDuckOrdinal;
    const timer = setTimeout(() => {
      this.#musicDucks.delete(id);
      this.#applyMusicVolume(0.08);
    }, Math.max(0, durationMs));
    this.#musicDucks.set(id, {
      amount: Math.max(0, Math.min(1, amount)),
      timer,
    });
    this.#applyMusicVolume();
  }

  async dispose(): Promise<void> {
    const context = this.#context;
    this.stopGlitchPreviewLoop();
    this.clearCallouts();
    this.#stopMusicImmediately();
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
    this.#loadedModules.clear();
    this.#calloutBufferCache.clear();
    if (context !== null && context.state !== "closed") await context.close();
  }

  #applyEffectsVolume(): void {
    if (this.#context === null || this.#effectsBus === null) return;
    const value = this.#effectsMuted ? 0 : presenceGain(this.#effectsVolume);
    this.#effectsBus.gain.cancelScheduledValues(this.#context.currentTime);
    this.#effectsBus.gain.setTargetAtTime(value, this.#context.currentTime, 0.01);
  }

  #applyMusicVolume(timeConstant = 0.02): void {
    if (this.#context === null || this.#musicBus === null) return;
    const duck = [...this.#musicDucks.values()].reduce(
      (amount, request) => Math.min(amount, request.amount),
      1,
    );
    const value = this.#musicMuted || this.#musicPaused || this.#musicStopping
      ? 0
      : musicGain(this.#musicVolume) * this.#musicMix * duck;
    this.#musicBus.gain.cancelScheduledValues(this.#context.currentTime);
    this.#musicBus.gain.setTargetAtTime(value, this.#context.currentTime, timeConstant);
  }

  #applyCalloutsVolume(): void {
    if (this.#context === null || this.#calloutsBus === null) return;
    const value = this.#calloutsMuted ? 0 : presenceGain(this.#calloutsVolume);
    this.#calloutsBus.gain.cancelScheduledValues(this.#context.currentTime);
    this.#calloutsBus.gain.setTargetAtTime(value, this.#context.currentTime, 0.01);
  }

  #clearMusicDucks(): void {
    for (const request of this.#musicDucks.values()) clearTimeout(request.timer);
    this.#musicDucks.clear();
    this.#applyMusicVolume(0.08);
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

  async #loadCurrentMusicTrack(index: number, generation: number): Promise<void> {
    const program = this.#musicProgram;
    const track = program?.tracks[index];
    if (program === null || track === undefined) return;
    try {
      const data = await this.#loadModule(track.assetUrl);
      if (generation !== this.#musicLoadGeneration || this.#musicProgram !== program) return;
      const samplingRate = this.#context?.sampleRate ?? DEFAULT_MUSIC_SAMPLE_RATE;
      this.#musicTrackIndex = index;
      this.#musicTrack = track;
      this.#musicReplay = new ModReplay(data, samplingRate);
      this.#nextMusicTrackIndex = null;
      this.#nextMusicReplay = null;
      this.#musicTransitioning = false;
      this.#musicScheduledUntilSeconds = 0;
      this.#musicAnchorTimeSeconds = null;
      this.#prepareNextMusicTrack(generation);
      this.#startMusicScheduler();
    } catch {
      if (generation !== this.#musicLoadGeneration || this.#musicProgram !== program) return;
      this.#evictModule(track.assetUrl);
      this.#failedMusicTracks.add(track.id);
      const nextIndex = this.#nextPlayableTrackIndex(index);
      if (nextIndex === null || nextIndex === index) {
        // Music is optional. Effects and gameplay remain available if every
        // bundled module fails on a particular host.
        this.#musicTrack = null;
        this.#musicReplay = null;
        return;
      }
      await this.#loadCurrentMusicTrack(nextIndex, generation);
    }
  }

  #prepareNextMusicTrack(generation: number): void {
    const program = this.#musicProgram;
    const currentIndex = this.#musicTrackIndex;
    const nextIndex = this.#nextPlayableTrackIndex(currentIndex);
    if (program === null || nextIndex === null || nextIndex === currentIndex) {
      this.#nextMusicTrackIndex = null;
      this.#nextMusicReplay = null;
      return;
    }
    const track = program.tracks[nextIndex];
    if (track === undefined) return;
    this.#nextMusicTrackIndex = nextIndex;
    this.#nextMusicReplay = null;
    const install = (data: ArrayBuffer): void => {
      if (
        generation !== this.#musicLoadGeneration ||
        this.#musicProgram !== program ||
        this.#musicTrackIndex !== currentIndex ||
        this.#nextMusicTrackIndex !== nextIndex
      ) {
        return;
      }
      const samplingRate = this.#context?.sampleRate ?? DEFAULT_MUSIC_SAMPLE_RATE;
      try {
        this.#nextMusicReplay = new ModReplay(data, samplingRate);
      } catch {
        this.#rejectNextMusicTrack(track, generation);
      }
    };
    const loaded = this.#loadedModules.get(track.assetUrl);
    if (loaded !== undefined) {
      install(loaded);
      return;
    }
    void this.#loadModule(track.assetUrl).then(install).catch(() => {
      if (
        generation === this.#musicLoadGeneration &&
        this.#musicProgram === program &&
        this.#musicTrackIndex === currentIndex &&
        this.#nextMusicTrackIndex === nextIndex
      ) {
        this.#rejectNextMusicTrack(track, generation);
      }
    });
  }

  #rejectNextMusicTrack(track: ModuleTrack, generation: number): void {
    this.#evictModule(track.assetUrl);
    this.#failedMusicTracks.add(track.id);
    this.#nextMusicTrackIndex = null;
    this.#nextMusicReplay = null;
    this.#prepareNextMusicTrack(generation);
  }

  #nextPlayableTrackIndex(afterIndex: number): number | null {
    const program = this.#musicProgram;
    if (program === null) return null;
    for (let offset = 1; offset <= program.tracks.length; offset += 1) {
      const index = (afterIndex + offset) % program.tracks.length;
      const track = program.tracks[index];
      if (track !== undefined && !this.#failedMusicTracks.has(track.id)) return index;
    }
    return null;
  }

  #loadModule(assetUrl: string): Promise<ArrayBuffer> {
    const cached = this.#moduleCache.get(assetUrl);
    if (cached !== undefined) return cached;
    const pending = this.#moduleLoader(assetUrl).then((data) => {
      this.#loadedModules.set(assetUrl, data);
      return data;
    }).catch((error: unknown) => {
      this.#evictModule(assetUrl);
      throw error;
    });
    this.#moduleCache.set(assetUrl, pending);
    return pending;
  }

  #evictModule(assetUrl: string): void {
    this.#moduleCache.delete(assetUrl);
    this.#loadedModules.delete(assetUrl);
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
      this.#musicPaused ||
      this.#musicStopping
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
    if (context !== null && replay !== null && this.#scheduledMusicChunks.length > 0) {
      const first = this.#scheduledMusicChunks[0]!;
      const last = this.#scheduledMusicChunks[this.#scheduledMusicChunks.length - 1]!;
      const audibleUntil = Math.min(
        Math.max(context.currentTime, first.startsAt),
        last.endsAt,
      );
      const chunk = this.#scheduledMusicChunks.find((candidate) =>
        candidate.endsAt >= audibleUntil
      ) ?? last;
      const elapsedSamples = Math.max(
        0,
        Math.min(
          MUSIC_CHUNK_SAMPLES,
          Math.round((audibleUntil - chunk.startsAt) * replay.samplingRate),
        ),
      );
      const span = chunk.spans.find((candidate) =>
        elapsedSamples < candidate.offsetSamples + candidate.lengthSamples
      );
      if (span === undefined) {
        this.#restoreMusicCursor(chunk.end);
      } else {
        const offset = Math.max(0, elapsedSamples - span.offsetSamples);
        this.#restoreMusicCursor({
          trackIndex: span.trackIndex,
          positionSamples: span.positionSamples + offset,
          transitionTrackIndex: span.transitionTrackIndex,
          transitionPositionSamples: span.transitionPositionSamples + offset,
        });
      }
    }
    this.#stopMusicSources();
    this.#scheduledMusicChunks.length = 0;
    this.#musicScheduledUntilSeconds = 0;
    this.#musicAnchorTimeSeconds = null;
  }

  #captureMusicCursor(): MusicCursorSnapshot {
    return {
      trackIndex: this.#musicTrackIndex,
      positionSamples: this.#musicReplay?.positionSamples ?? 0,
      transitionTrackIndex: this.#musicTransitioning
        ? this.#nextMusicTrackIndex
        : null,
      transitionPositionSamples: this.#musicTransitioning
        ? this.#nextMusicReplay?.positionSamples ?? 0
        : 0,
    };
  }

  #restoreMusicCursor(cursor: MusicCursorSnapshot): void {
    const program = this.#musicProgram;
    const track = program?.tracks[cursor.trackIndex];
    const data = track === undefined
      ? undefined
      : this.#loadedModules.get(track.assetUrl);
    if (program === null || track === undefined || data === undefined) return;
    const samplingRate = this.#context?.sampleRate ?? DEFAULT_MUSIC_SAMPLE_RATE;
    const replay = new ModReplay(data, samplingRate);
    replay.seek(cursor.positionSamples);
    this.#musicTrackIndex = cursor.trackIndex;
    this.#musicTrack = track;
    this.#musicReplay = replay;
    this.#nextMusicTrackIndex = null;
    this.#nextMusicReplay = null;
    this.#musicTransitioning = false;
    if (cursor.transitionTrackIndex !== null) {
      const nextTrack = program.tracks[cursor.transitionTrackIndex];
      const nextData = nextTrack === undefined
        ? undefined
        : this.#loadedModules.get(nextTrack.assetUrl);
      if (nextTrack !== undefined && nextData !== undefined) {
        const nextReplay = new ModReplay(nextData, samplingRate);
        nextReplay.seek(cursor.transitionPositionSamples);
        this.#nextMusicTrackIndex = cursor.transitionTrackIndex;
        this.#nextMusicReplay = nextReplay;
        this.#musicTransitioning = true;
        return;
      }
    }
    this.#prepareNextMusicTrack(this.#musicLoadGeneration);
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
      const startsAt = context.currentTime + (cueTone.delayMs ?? 0) / 1_000;
      const endsAt = startsAt + cueTone.durationMs / 1_000;
      if (
        priority !== null &&
        !this.#reserveSfxTone(priority, startsAt, endsAt)
      ) {
        continue;
      }
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
      {
        ...active.options,
        gain: (active.options.gain ?? 1) * PROCEDURAL_CALLOUT_GAIN[active.cue],
      },
      this.#calloutsMakeup,
      this.#calloutsMuted,
      null,
    );
    const durationMs = definition.reduce(
      (duration, tone) => Math.max(duration, (tone.delayMs ?? 0) + tone.durationMs),
      0,
    );
    this.duckMusic(durationMs);
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

  #reserveSfxTone(priority: number, startsAt: number, endsAt: number): boolean {
    const overlapping = [...this.#activeSfxTones].filter((active) =>
      active.startsAt < endsAt && active.endsAt > startsAt
    );
    if (overlapping.length < MAX_ACTIVE_SFX_TONES) return true;
    let candidate: ActiveTone | null = null;
    for (const active of overlapping) {
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
    const active: ActiveTone = {
      oscillator,
      envelope,
      panner,
      priority: priority ?? 0,
      startsAt,
      endsAt,
    };
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
    const pan = 0;
    const cueGain = Math.max(
      0,
      Math.min(2, (options.gain ?? 1) * RECORDED_CALLOUT_GAIN),
    );
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
    startsAt: number,
  ): void {
    const replay = this.#musicReplay;
    const program = this.#musicProgram;
    if (replay === null || program === null) return;
    const left = new Float32Array(MUSIC_CHUNK_SAMPLES);
    const right = new Float32Array(MUSIC_CHUNK_SAMPLES);
    const spans: MusicRenderSpan[] = [];
    let offset = 0;
    while (offset < MUSIC_CHUNK_SAMPLES && this.#musicReplay !== null) {
      const currentReplay = this.#musicReplay;
      const currentTrack = program.tracks[this.#musicTrackIndex];
      if (currentTrack === undefined) break;
      const crossfadeSamples = Math.min(
        currentReplay.durationSamples,
        Math.round(MUSIC_CROSSFADE_SECONDS * currentReplay.samplingRate),
      );
      const crossfadeStart = currentReplay.durationSamples - crossfadeSamples;
      const nextReady =
        this.#nextMusicTrackIndex !== null &&
        this.#nextMusicTrackIndex !== this.#musicTrackIndex &&
        this.#nextMusicReplay !== null;
      if (
        !this.#musicTransitioning &&
        nextReady &&
        currentReplay.positionSamples >= crossfadeStart
      ) {
        this.#musicTransitioning = true;
      }

      if (!this.#musicTransitioning) {
        const boundary = nextReady ? crossfadeStart : currentReplay.durationSamples;
        const count = Math.min(
          MUSIC_CHUNK_SAMPLES - offset,
          Math.max(0, boundary - currentReplay.positionSamples),
        );
        if (count === 0) {
          if (nextReady) {
            this.#musicTransitioning = true;
          } else {
            currentReplay.reset();
          }
          continue;
        }
        spans.push({
          offsetSamples: offset,
          lengthSamples: count,
          trackIndex: this.#musicTrackIndex,
          positionSamples: currentReplay.positionSamples,
          transitionTrackIndex: null,
          transitionPositionSamples: 0,
        });
        const end = offset + count;
        currentReplay.render(left.subarray(offset, end), right.subarray(offset, end));
        for (let sample = offset; sample < end; sample += 1) {
          left[sample] = (left[sample] ?? 0) * currentTrack.mixGain;
          right[sample] = (right[sample] ?? 0) * currentTrack.mixGain;
        }
        offset = end;
        continue;
      }

      const nextReplay = this.#nextMusicReplay;
      const nextTrackIndex = this.#nextMusicTrackIndex;
      const nextTrack = nextTrackIndex === null
        ? undefined
        : program.tracks[nextTrackIndex];
      if (nextReplay === null || nextTrackIndex === null || nextTrack === undefined) {
        this.#musicTransitioning = false;
        continue;
      }
      const count = Math.min(
        MUSIC_CHUNK_SAMPLES - offset,
        currentReplay.durationSamples - currentReplay.positionSamples,
      );
      const currentStart = currentReplay.positionSamples;
      const nextStart = nextReplay.positionSamples;
      spans.push({
        offsetSamples: offset,
        lengthSamples: count,
        trackIndex: this.#musicTrackIndex,
        positionSamples: currentStart,
        transitionTrackIndex: nextTrackIndex,
        transitionPositionSamples: nextStart,
      });
      const currentLeft = new Float32Array(count);
      const currentRight = new Float32Array(count);
      const nextLeft = new Float32Array(count);
      const nextRight = new Float32Array(count);
      currentReplay.render(currentLeft, currentRight);
      nextReplay.render(nextLeft, nextRight);
      for (let sample = 0; sample < count; sample += 1) {
        const progress = Math.max(
          0,
          Math.min(1, (currentStart - crossfadeStart + sample) / crossfadeSamples),
        );
        const outgoing = Math.cos(progress * Math.PI / 2) * currentTrack.mixGain;
        const incoming = Math.sin(progress * Math.PI / 2) * nextTrack.mixGain;
        left[offset + sample] =
          (currentLeft[sample] ?? 0) * outgoing +
          (nextLeft[sample] ?? 0) * incoming;
        right[offset + sample] =
          (currentRight[sample] ?? 0) * outgoing +
          (nextRight[sample] ?? 0) * incoming;
      }
      offset += count;
      if (count === currentReplay.durationSamples - currentStart) {
        this.#musicTrackIndex = nextTrackIndex;
        this.#musicTrack = nextTrack;
        this.#musicReplay = nextReplay;
        this.#nextMusicTrackIndex = null;
        this.#nextMusicReplay = null;
        this.#musicTransitioning = false;
        this.#prepareNextMusicTrack(this.#musicLoadGeneration);
      }
    }
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
    const chunk: ScheduledMusicChunk = {
      startsAt,
      endsAt: startsAt + MUSIC_CHUNK_SAMPLES / replay.samplingRate,
      spans,
      end: this.#captureMusicCursor(),
    };
    this.#scheduledMusicChunks.push(chunk);
    this.#musicSources.add(source);
    source.onended = () => {
      this.#musicSources.delete(source);
      const chunkIndex = this.#scheduledMusicChunks.indexOf(chunk);
      if (chunkIndex >= 0) this.#scheduledMusicChunks.splice(chunkIndex, 1);
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
