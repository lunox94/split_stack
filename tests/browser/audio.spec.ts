import { expect, test } from "@playwright/test";

interface RenderedLevel {
  readonly peak: number;
  readonly activeRms: number;
  readonly probeRms: number;
  readonly activeDurationMs: number;
  readonly highFrequencyRatio: number;
}

test("Music, SFX, and Callouts remain independent and retain safe headroom", async ({
  page,
}) => {
  await page.goto("/");

  const levels = await page.evaluate(async () => {
    const audioEngineModuleUrl = "/src/audio/engine.ts";
    const { AudioEngine } = await import(
      /* @vite-ignore */ audioEngineModuleUrl
    ) as typeof import("../../src/audio/engine");
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
        if (index > 0) differenceEnergy += (sample - (samples[index - 1] ?? 0)) ** 2;
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

    return {
      move: await render((engine) => engine.play("move")),
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
      stackedImpactFull: await render((engine) => {
        for (let index = 0; index < 6; index += 1) engine.play("four-line");
      }, 1),
      stackedImpactQuarter: await render((engine) => {
        for (let index = 0; index < 6; index += 1) engine.play("four-line");
      }, 0.25),
    };
  });

  expect(levels.move.peak).toBeGreaterThanOrEqual(0.05);
  expect(levels.move.activeRms).toBeGreaterThanOrEqual(0.012);

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
  expect(levels.garbage.highFrequencyRatio).toBeGreaterThanOrEqual(0.08);

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
  expect(collapseMusicRatio).toBeGreaterThanOrEqual(0.84);
  expect(collapseMusicRatio).toBeLessThanOrEqual(0.92);
  const renderedMusicRms = levels.musicTracks.map((track) => track.activeRms);
  expect(Math.max(...renderedMusicRms) / Math.min(...renderedMusicRms))
    .toBeLessThanOrEqual(1.6);
  expect(levels.garbage.activeRms).toBeGreaterThan(levels.musicOnly.activeRms * 1.5);
  expect(levels.combo2Voice.activeRms).toBeGreaterThan(levels.musicOnly.activeRms);
  expect(levels.stackedImpactFull.peak).toBeLessThanOrEqual(0.8);
  const quarterVolumeRatio = levels.stackedImpactQuarter.peak /
    levels.stackedImpactFull.peak;
  expect(quarterVolumeRatio).toBeGreaterThanOrEqual(0.05);
  expect(quarterVolumeRatio).toBeLessThanOrEqual(0.08);
});
