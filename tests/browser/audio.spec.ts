import { expect, test } from "@playwright/test";

interface RenderedLevel {
  readonly peak: number;
  readonly activeRms: number;
}

test("gameplay effects stay audible with music disabled and retain safe headroom", async ({
  page,
}) => {
  await page.goto("/");

  const levels = await page.evaluate(async () => {
    const audioEngineModuleUrl = "/src/audio/engine.ts";
    const { AudioEngine } = await import(
      /* @vite-ignore */ audioEngineModuleUrl
    ) as typeof import("../../src/audio/engine");
    const NativeOfflineAudioContext = window.OfflineAudioContext;

    const render = async (
      play: (engine: InstanceType<typeof AudioEngine>) => void,
      effectsVolume = 0.8,
    ): Promise<RenderedLevel> => {
      let offlineContext: OfflineAudioContext | null = null;

      class CaptureAudioContext {
        readonly destination: AudioDestinationNode;
        readonly sampleRate: number;
        state: AudioContextState = "running";
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
          return offlineContext!.createBufferSource();
        }

        createBuffer(
          numberOfChannels: number,
          length: number,
          sampleRate: number,
        ): AudioBuffer {
          return offlineContext!.createBuffer(numberOfChannels, length, sampleRate);
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
      play(engine);

      const rendered = await offlineContext!.startRendering();
      const samples = rendered.getChannelData(0);
      let peak = 0;
      let activeEnergy = 0;
      let activeSamples = 0;
      for (const sample of samples) {
        const magnitude = Math.abs(sample);
        peak = Math.max(peak, magnitude);
        if (magnitude > 0.000_01) {
          activeEnergy += sample * sample;
          activeSamples += 1;
        }
      }
      const level = {
        peak,
        activeRms: Math.sqrt(activeEnergy / Math.max(1, activeSamples)),
      };
      await engine.dispose();
      return level;
    };

    return {
      move: await render((engine) => engine.play("move")),
      hardDrop: await render((engine) => engine.play("hard-drop")),
      single: await render((engine) => engine.play("single")),
      fourLine: await render((engine) => engine.play("four-line")),
      garbage: await render((engine) => engine.playGarbageRise(4)),
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
    levels.garbage,
  ]) {
    expect(impact.peak).toBeGreaterThanOrEqual(0.1);
    expect(impact.activeRms).toBeGreaterThanOrEqual(0.025);
  }

  expect(levels.hardDrop.peak).toBeGreaterThan(levels.move.peak);
  expect(levels.stackedImpactFull.peak).toBeLessThanOrEqual(0.8);
  const quarterVolumeRatio = levels.stackedImpactQuarter.peak /
    levels.stackedImpactFull.peak;
  expect(quarterVolumeRatio).toBeGreaterThanOrEqual(0.24);
  expect(quarterVolumeRatio).toBeLessThanOrEqual(0.26);
});
