import { expect, test } from "@playwright/test";

interface RenderedLevel {
  readonly peak: number;
  readonly activeRms: number;
  readonly probeRms: number;
  readonly activeDurationMs: number;
  readonly highFrequencyRatio: number;
  readonly maxSampleStep: number;
}

test("Music, SFX, and Callouts remain independent and retain safe headroom", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto("/");

  const levels = await page.evaluate(async () => {
    const audioEngineModuleUrl = "/src/audio/engine.ts";
    const { AudioEngine } = await import(
      /* @vite-ignore */ audioEngineModuleUrl
    ) as typeof import("../../src/audio/engine");
    const cueModuleUrl = "/src/audio/cues.ts";
    const { CUE_DEFINITIONS } = await import(
      /* @vite-ignore */ cueModuleUrl
    ) as typeof import("../../src/audio/cues");
    const NativeOfflineAudioContext = window.OfflineAudioContext;
    interface CaptureContext {
      readonly bufferSourceCount: number;
      advanceTo(time: number): void;
    }

    const render = async (
      play: (
        engine: InstanceType<typeof AudioEngine>,
        context: CaptureContext,
      ) => void | Promise<void>,
      effectsVolume = 0.85,
      calloutsVolume = 0.85,
    ): Promise<RenderedLevel> => {
      let offlineContext: OfflineAudioContext | null = null;

      class CaptureAudioContext {
        readonly destination: AudioDestinationNode;
        readonly sampleRate: number;
        state: AudioContextState = "running";
        bufferSourceCount = 0;
        private virtualCurrentTime = 0;

        constructor() {
          offlineContext = new NativeOfflineAudioContext(2, 88_200, 44_100);
          this.destination = offlineContext.destination;
          this.sampleRate = offlineContext.sampleRate;
        }

        get currentTime(): number {
          return this.virtualCurrentTime;
        }

        advanceTo(time: number): void {
          this.virtualCurrentTime = time;
        }

        createGain(): GainNode {
          return offlineContext!.createGain();
        }

        createWaveShaper(): WaveShaperNode {
          return offlineContext!.createWaveShaper();
        }

        createStereoPanner(): StereoPannerNode {
          return offlineContext!.createStereoPanner();
        }

        createOscillator(): OscillatorNode {
          return offlineContext!.createOscillator();
        }

        createBufferSource(): AudioBufferSourceNode {
          this.bufferSourceCount += 1;
          return offlineContext!.createBufferSource();
        }

        createBuffer(
          numberOfChannels: number,
          length: number,
          sampleRate: number,
        ): AudioBuffer {
          return offlineContext!.createBuffer(numberOfChannels, length, sampleRate);
        }

        decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer> {
          return offlineContext!.decodeAudioData(audioData);
        }

        async resume(): Promise<void> {
          this.state = "running";
        }

        async close(): Promise<void> {
          this.state = "closed";
        }
      }

      const captureContext = new CaptureAudioContext();
      const engine = new AudioEngine({
        contextFactory: () => captureContext as unknown as AudioContext,
      });
      if (!await engine.unlock()) throw new Error("AudioEngine did not unlock");
      engine.setEffectsMuted(false);
      engine.setEffectsVolume(effectsVolume);
      engine.setCalloutsVolume(calloutsVolume);
      engine.setMusicMuted(true);
      captureContext.advanceTo(0.12);
      await play(engine, captureContext);

      const rendered = await offlineContext!.startRendering();
      const samples = rendered.getChannelData(0);
      const rightSamples = rendered.getChannelData(1);
      let peak = 0;
      let activeEnergy = 0;
      let activeSamples = 0;
      let differenceEnergy = 0;
      let maxSampleStep = 0;
      let firstActive = samples.length;
      let lastActive = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index] ?? 0;
        const magnitude = Math.abs(sample);
        peak = Math.max(peak, magnitude);
        if (magnitude > 0.000_01) {
          activeEnergy += sample * sample;
          activeSamples += 1;
          firstActive = Math.min(firstActive, index);
          lastActive = index;
        }
        if (index > 0) {
          const step = Math.abs(sample - (samples[index - 1] ?? 0));
          differenceEnergy += step ** 2;
          maxSampleStep = Math.max(maxSampleStep, step);
        }
      }
      const level = {
        peak,
        activeRms: Math.sqrt(activeEnergy / Math.max(1, activeSamples)),
        probeRms: Math.sqrt(
          rightSamples.slice(7_056, 15_435).reduce(
            (energy, sample) => energy + sample * sample,
            0,
          ) / (15_435 - 7_056),
        ),
        activeDurationMs: Math.max(0, lastActive - firstActive) / 44.1,
        highFrequencyRatio: Math.sqrt(
          differenceEnergy / Math.max(1, activeEnergy),
        ),
        maxSampleStep,
      };
      await engine.dispose();
      return level;
    };

    const startMusic = async (
      engine: InstanceType<typeof AudioEngine>,
      context: CaptureContext,
      rematchIndex = 0,
    ): Promise<void> => {
      engine.setMusicMuted(false);
      engine.startMusic("collapse-continuity", rematchIndex);
      for (let attempt = 0; attempt < 100 && context.bufferSourceCount === 0; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      if (context.bufferSourceCount === 0) throw new Error("Tracker PCM was not scheduled");
    };

    const allSfx = Object.fromEntries(await Promise.all(
      (Object.keys(CUE_DEFINITIONS) as Array<keyof typeof CUE_DEFINITIONS>)
        .map(async (cue) => [
          cue,
          await render((engine) => engine.play(cue)),
        ] as const),
    ));
    const powerCalloutCues = [
      "power-scramble",
      "power-nuke",
      "power-collapse",
      "power-monomino-rush",
      "power-acid-rain",
      "power-oversize",
      "power-ghost-jam",
    ] as const;
    const powerCallouts = Object.fromEntries(await Promise.all(
      powerCalloutCues.map(async (cue) => [
        cue,
        await render((engine) => engine.playCallout(cue)),
      ] as const),
    ));

    return {
      allSfx,
      powerCallouts,
      mediumMove: await render((engine) => engine.play("move"), 0.4),
      mediumSingle: await render((engine) => engine.play("single"), 0.4),
      mediumPowerCallout: await render(
        (engine) => engine.playCallout("power-monomino-rush"),
        0.85,
        0.4,
      ),
      move: await render((engine) => engine.play("move")),
      softDrop: await render((engine) => engine.play("soft-drop")),
      lock: await render((engine) => engine.play("lock")),
      placement: await render((engine) => {
        engine.play("hard-drop");
        engine.play("lock");
      }),
      hardDrop: await render((engine) => engine.play("hard-drop")),
      single: await render((engine) => engine.play("single")),
      fourLine: await render((engine) => engine.play("four-line")),
      hollowCross: await render((engine) => engine.play("hollow-cross")),
      garbage: await render((engine) => engine.playGarbageRise(4)),
      combo2Voice: await render(async (engine, context) => {
        engine.playCallout("combo-2");
        for (let attempt = 0; attempt < 100 && context.bufferSourceCount === 0; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 10));
        }
        if (context.bufferSourceCount === 0) {
          throw new Error("Recorded Combo 2 callout was not decoded and scheduled");
        }
      }),
      combo3Voice: await render(async (engine, context) => {
        engine.playCallout("combo-3");
        for (let attempt = 0; attempt < 100 && context.bufferSourceCount === 0; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 10));
        }
        if (context.bufferSourceCount === 0) {
          throw new Error("Recorded Combo 3 callout was not decoded and scheduled");
        }
      }),
      combo4Voice: await render(async (engine, context) => {
        engine.playCallout("combo-4");
        for (let attempt = 0; attempt < 100 && context.bufferSourceCount === 0; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 10));
        }
        if (context.bufferSourceCount === 0) {
          throw new Error("Recorded Combo 4 callout was not decoded and scheduled");
        }
      }),
      calloutWithEffectsMuted: await render((engine) => {
        engine.setEffectsMuted(true);
        engine.playCallout("combo-5-plus");
      }),
      mutedCallout: await render((engine) => {
        engine.setCalloutsMuted(true);
        engine.playCallout("combo-5-plus");
      }),
      combinedImpact: await render((engine) => {
        engine.play("four-line");
        engine.playCallout("combo-5-plus");
      }, 1),
      musicOnly: await render((engine, context) => startMusic(engine, context)),
      musicTracks: await Promise.all([0, 1, 2, 3].map((rematchIndex) =>
        render((engine, context) => startMusic(engine, context, rematchIndex))
      )),
      musicWithCollapse: await render(async (engine, context) => {
        await startMusic(engine, context);
        context.advanceTo(0.12);
        engine.play("collapse-impact", { pan: -1 });
      }),
      mediumMusicWithSingle: await render(async (engine, context) => {
        await startMusic(engine, context);
        context.advanceTo(0.12);
        engine.play("single");
      }, 0.4),
      stackedImpactFull: await render((engine) => {
        for (let index = 0; index < 6; index += 1) engine.play("four-line");
      }, 1),
      stackedImpactQuarter: await render((engine) => {
        for (let index = 0; index < 6; index += 1) engine.play("four-line");
      }, 0.25),
    };
  });

  expect(levels.move.peak).toBeGreaterThanOrEqual(0.12);
  expect(levels.move.activeRms).toBeGreaterThanOrEqual(0.025);
  expect(levels.softDrop.peak).toBeGreaterThanOrEqual(0.1);
  expect(levels.softDrop.activeRms).toBeGreaterThanOrEqual(0.02);
  expect.soft(levels.move.maxSampleStep).toBeLessThanOrEqual(0.012);
  // These cues deliberately carry a short upper-frequency signature. Adjacent
  // samples therefore move farther than the low movement tone even though the
  // sine/triangle sources and their envelopes remain continuous.
  expect.soft(levels.softDrop.maxSampleStep).toBeLessThanOrEqual(0.025);
  expect.soft(levels.lock.maxSampleStep).toBeLessThanOrEqual(0.025);
  expect.soft(levels.placement.maxSampleStep).toBeLessThanOrEqual(0.025);
  expect.soft(levels.garbage.maxSampleStep).toBeLessThanOrEqual(0.025);
  for (const [cue, peakFloor, rmsFloor] of [
    ["soft-drop", 0.16, 0.03],
    ["hard-drop", 0.28, 0.05],
    ["lock", 0.22, 0.04],
    ["garbage-warning", 0.24, 0.04],
    ["power-blackout", 0.28, 0.045],
    ["nuke-impact", 0.34, 0.055],
    ["oversize-arrival", 0.36, 0.06],
    ["acid-consume", 0.18, 0.03],
  ] as const) {
    const level = levels.allSfx[cue]!;
    expect.soft(level.peak, `${cue} audibility peak`)
      .toBeGreaterThanOrEqual(peakFloor);
    expect.soft(level.activeRms, `${cue} audibility RMS`)
      .toBeGreaterThanOrEqual(rmsFloor);
  }
  expect(levels.allSfx["nuke-impact"]!.highFrequencyRatio)
    .toBeGreaterThanOrEqual(0.035);
  expect(levels.mediumMove.activeRms / levels.move.activeRms)
    .toBeGreaterThanOrEqual(0.32);
  expect(levels.mediumSingle.activeRms / levels.single.activeRms)
    .toBeGreaterThanOrEqual(0.32);
  expect(
    levels.mediumPowerCallout.activeRms /
      levels.powerCallouts["power-monomino-rush"]!.activeRms,
  ).toBeGreaterThanOrEqual(0.32);
  for (const [cue, level] of Object.entries(levels.allSfx)) {
    expect.soft(level.maxSampleStep, `${cue} sample continuity`)
      // A 2.3 kHz nuke accent has a naturally steeper sample-to-sample slope;
      // the ceiling still catches discontinuities large enough to sound as pops.
      .toBeLessThanOrEqual(0.08);
    expect.soft(level.peak, `${cue} output ceiling`).toBeLessThanOrEqual(0.8);
  }
  for (const [cue, level] of Object.entries(levels.powerCallouts)) {
    expect.soft(level.maxSampleStep, `${cue} sample continuity`)
      .toBeLessThanOrEqual(0.04);
    expect.soft(level.peak, `${cue} output ceiling`).toBeLessThanOrEqual(0.9);
  }

  for (const impact of [
    levels.hardDrop,
    levels.single,
    levels.fourLine,
    levels.hollowCross,
    levels.garbage,
  ]) {
    expect(impact.peak).toBeGreaterThanOrEqual(0.1);
    expect(impact.activeRms).toBeGreaterThanOrEqual(0.025);
  }
  expect(levels.garbage.activeDurationMs).toBeGreaterThanOrEqual(500);
  expect(levels.garbage.highFrequencyRatio).toBeGreaterThanOrEqual(0.015);

  expect(levels.hardDrop.peak).toBeGreaterThan(levels.move.peak);
  expect(levels.combo2Voice.peak).toBeGreaterThan(0.05);
  expect(levels.combo2Voice.activeRms).toBeGreaterThan(0.01);
  expect(levels.combo2Voice.peak).toBeLessThanOrEqual(0.95);
  expect(levels.combo3Voice.peak).toBeGreaterThan(0.05);
  expect(levels.combo3Voice.activeRms).toBeGreaterThan(0.01);
  expect(levels.combo3Voice.peak).toBeLessThanOrEqual(0.95);
  expect(levels.combo4Voice.peak).toBeGreaterThan(0.05);
  expect(levels.combo4Voice.activeRms).toBeGreaterThan(0.01);
  expect(levels.combo4Voice.peak).toBeLessThanOrEqual(0.95);
  expect(levels.calloutWithEffectsMuted.activeRms).toBeGreaterThan(0.02);
  expect(levels.mutedCallout.peak).toBe(0);
  expect(levels.combinedImpact.peak).toBeLessThanOrEqual(0.95);
  expect(levels.musicWithCollapse.peak).toBeLessThanOrEqual(0.95);
  const collapseMusicRatio = levels.musicWithCollapse.probeRms /
    levels.musicOnly.probeRms;
  expect(collapseMusicRatio).toBeGreaterThanOrEqual(0.68);
  expect(collapseMusicRatio).toBeLessThanOrEqual(0.76);
  const singleMusicRatio = levels.mediumMusicWithSingle.probeRms /
    levels.musicOnly.probeRms;
  expect(singleMusicRatio).toBeGreaterThanOrEqual(0.78);
  expect(singleMusicRatio).toBeLessThanOrEqual(0.86);
  const renderedMusicRms = levels.musicTracks.map((track) => track.activeRms);
  // Complete-track calibration is tighter; this short startup window permits
  // quieter authored intros while still catching gross gain regressions.
  expect(Math.max(...renderedMusicRms) / Math.min(...renderedMusicRms))
    .toBeLessThanOrEqual(2.6);
  expect(levels.garbage.activeRms).toBeGreaterThan(levels.musicOnly.activeRms * 1.5);
  expect(levels.combo2Voice.activeRms).toBeGreaterThan(levels.musicOnly.activeRms);
  expect(levels.stackedImpactFull.peak).toBeLessThanOrEqual(0.8);
  const quarterVolumeRatio = levels.stackedImpactQuarter.peak /
    levels.stackedImpactFull.peak;
  expect(quarterVolumeRatio).toBeGreaterThanOrEqual(0.13);
  expect(quarterVolumeRatio).toBeLessThanOrEqual(0.16);
});
