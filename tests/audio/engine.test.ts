import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AudioEngine } from "../../src/audio/engine";
import { CUE_DEFINITIONS, GLITCH_PREVIEW_STEP_MS } from "../../src/audio/cues";

const trackerModule = (): ArrayBuffer => {
  const bytes = readFileSync(resolve("public/music/radix-mountain_king.mod"));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
};

function fakeAudioContext(): AudioContext & {
  currentTime: number;
  state: AudioContextState;
  resume: ReturnType<typeof vi.fn>;
} {
  const parameter = () => ({
    cancelScheduledValues: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
  });
  const connectable = <T extends object>(value: T): T & { connect: ReturnType<typeof vi.fn> } => {
    const node = value as T & { connect: ReturnType<typeof vi.fn> };
    node.connect = vi.fn(() => node);
    return node;
  };
  const context = {
    currentTime: 1,
    destination: {},
    sampleRate: 44_100,
    state: "running" as AudioContextState,
    createGain: vi.fn(() => connectable({ gain: parameter() })),
    createStereoPanner: vi.fn(() => connectable({ pan: parameter() })),
    createOscillator: vi.fn(() =>
      connectable({
        frequency: parameter(),
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
        type: "square",
      }),
    ),
    createBufferSource: vi.fn(() =>
      connectable({
        buffer: null,
        loop: false,
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
      }),
    ),
    createBuffer: vi.fn((_channels: number, length: number) => {
      const channelData = [new Float32Array(length), new Float32Array(length)];
      return {
        getChannelData: (channel: number) => channelData[channel],
      };
    }),
    close: vi.fn(async () => {
      context.state = "closed";
    }),
    resume: vi.fn(async () => {
      context.state = "running";
    }),
  };
  return context as unknown as AudioContext & {
    currentTime: number;
    state: AudioContextState;
    resume: ReturnType<typeof vi.fn>;
  };
}

describe("audio engine lifecycle", () => {
  it("streams tracker PCM and resumes it after a suspended audio context", async () => {
    const context = fakeAudioContext();
    const engine = new AudioEngine({
      contextFactory: () => context,
      moduleLoader: async () => trackerModule(),
    });
    expect(await engine.unlock()).toBe(true);
    engine.startMenuMusic();
    await vi.waitFor(() => {
      engine.updateMusic();
      expect(context.createBufferSource).toHaveBeenCalled();
    });
    const scheduledBeforePause = vi.mocked(context.createBufferSource).mock.calls.length;
    const firstSource = vi.mocked(context.createBufferSource).mock.results[0]?.value;
    const firstBuffer = vi.mocked(context.createBuffer).mock.results[0]?.value;
    const secondBuffer = vi.mocked(context.createBuffer).mock.results[1]?.value;
    const firstStartsAt = vi.mocked(firstSource?.start).mock.calls[0]?.[0];
    expect(firstStartsAt).toBeDefined();
    expect(firstBuffer).toBeDefined();
    expect(secondBuffer).toBeDefined();

    const pausedAtSample = 4_096;
    context.currentTime = (firstStartsAt ?? context.currentTime) +
      pausedAtSample / context.sampleRate;

    engine.pauseMusic();
    expect(firstSource?.stop).toHaveBeenCalled();
    context.state = "suspended";

    engine.resumeMusic();
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      engine.updateMusic();
      expect(vi.mocked(context.createBufferSource).mock.calls.length)
        .toBeGreaterThan(scheduledBeforePause);
    });
    const resumedBuffer = vi.mocked(context.createBuffer).mock.results[
      scheduledBeforePause
    ]?.value;
    expect(resumedBuffer).toBeDefined();

    // Seeking applies a 64-sample anti-click ramp. Past that ramp, resuming
    // midway through the first queued chunk must match the uninterrupted PCM.
    expect(resumedBuffer?.getChannelData(0).slice(64, pausedAtSample)).toEqual(
      firstBuffer?.getChannelData(0).slice(pausedAtSample + 64),
    );
    expect(resumedBuffer?.getChannelData(1).slice(64, pausedAtSample)).toEqual(
      firstBuffer?.getChannelData(1).slice(pausedAtSample + 64),
    );
    expect(resumedBuffer?.getChannelData(0).slice(pausedAtSample)).toEqual(
      secondBuffer?.getChannelData(0).slice(0, pausedAtSample),
    );
    expect(resumedBuffer?.getChannelData(1).slice(pausedAtSample)).toEqual(
      secondBuffer?.getChannelData(1).slice(0, pausedAtSample),
    );

    expect(context.state).toBe("running");
  });

  it("does not schedule inaudible sources while either audio bus is muted", async () => {
    const context = fakeAudioContext();
    const engine = new AudioEngine({
      contextFactory: () => context,
      moduleLoader: async () => trackerModule(),
    });
    expect(await engine.unlock()).toBe(true);
    engine.startMenuMusic();
    engine.setMusicMuted(true);

    engine.updateMusic();
    expect(context.createBufferSource).not.toHaveBeenCalled();

    engine.setMusicMuted(false);
    await vi.waitFor(() => {
      engine.updateMusic();
      expect(context.createBufferSource).toHaveBeenCalled();
    });

    vi.mocked(context.createOscillator).mockClear();
    engine.setEffectsMuted(true);
    engine.play("move");
    expect(context.createOscillator).not.toHaveBeenCalled();

    engine.setEffectsMuted(false);
    engine.play("move");
    expect(context.createOscillator).toHaveBeenCalled();
  });

  it("makes larger clears audibly denser while retaining one shared clear signature", () => {
    const clears = [
      CUE_DEFINITIONS.single,
      CUE_DEFINITIONS.double,
      CUE_DEFINITIONS.triple,
      CUE_DEFINITIONS["four-line"],
    ];

    expect(clears.map((definition) => definition.length)).toEqual([2, 3, 4, 5]);
    expect(clears.map((definition) => definition[0]?.frequency)).toEqual([
      510,
      510,
      510,
      510,
    ]);
    expect(clears.map((definition) =>
      definition.reduce((energy, tone) => energy + tone.gain * tone.durationMs, 0)
    )).toEqual([...clears].map((definition) =>
      definition.reduce((energy, tone) => energy + tone.gain * tone.durationMs, 0)
    ).sort((left, right) => left - right));
    expect(
      CUE_DEFINITIONS["four-line"][CUE_DEFINITIONS["four-line"].length - 1]
        ?.frequency,
    ).toBeGreaterThan(1_000);
  });

  it("gives Oversize, Ghost Jam, and Glitch their own readable sound identities", () => {
    const oversize = CUE_DEFINITIONS["power-oversize"];
    const ghostJam = CUE_DEFINITIONS["power-ghost-jam"];
    const glitchLow = CUE_DEFINITIONS["glitch-preview-low"][0]!;
    const glitchHigh = CUE_DEFINITIONS["glitch-preview-high"][0]!;

    expect(oversize.some((cue) => cue.frequency < 100)).toBe(true);
    expect(oversize.some((cue) =>
      cue.endFrequency !== undefined && cue.endFrequency > cue.frequency
    )).toBe(true);
    expect(ghostJam.every((cue) =>
      cue.endFrequency !== undefined && cue.endFrequency < cue.frequency
    )).toBe(true);
    expect([glitchLow.frequency, glitchHigh.frequency]).toEqual([620, 880]);
    expect(Math.max(glitchLow.gain, glitchHigh.gain)).toBeLessThan(0.03);
    expect(Math.max(glitchLow.durationMs, glitchHigh.durationMs))
      .toBeLessThan(GLITCH_PREVIEW_STEP_MS);
  });

  it("plays one garbage lift-and-slam whose weight and duration scale with its batch", async () => {
    const context = fakeAudioContext();
    const engine = new AudioEngine({ contextFactory: () => context });
    expect(await engine.unlock()).toBe(true);

    engine.playGarbageRise(1, { pan: -0.5 });
    const oneRowOscillators = vi.mocked(context.createOscillator).mock.results
      .map((result) => result.value);
    const oneRowStops = oneRowOscillators.map((oscillator) =>
      vi.mocked(oscillator.stop).mock.calls[0]?.[0] as number
    );
    expect(oneRowOscillators).toHaveLength(2);
    expect(vi.mocked(context.createStereoPanner).mock.results.map((result) =>
      vi.mocked(result.value.pan.setValueAtTime).mock.calls[0]?.[0]
    )).toEqual([-0.5, -0.5]);

    vi.mocked(context.createOscillator).mockClear();
    vi.mocked(context.createStereoPanner).mockClear();
    engine.playGarbageRise(4, { pan: 0.5 });
    const fourRowOscillators = vi.mocked(context.createOscillator).mock.results
      .map((result) => result.value);
    const fourRowStops = fourRowOscillators.map((oscillator) =>
      vi.mocked(oscillator.stop).mock.calls[0]?.[0] as number
    );

    // A batch remains one layered event instead of repeating once per row.
    expect(fourRowOscillators).toHaveLength(2);
    expect(vi.mocked(context.createStereoPanner).mock.results.map((result) =>
      vi.mocked(result.value.pan.setValueAtTime).mock.calls[0]?.[0]
    )).toEqual([0.5, 0.5]);
    expect(Math.max(...fourRowStops)).toBeGreaterThan(Math.max(...oneRowStops));
    expect(
      vi.mocked(fourRowOscillators[1]!.frequency.exponentialRampToValueAtTime)
        .mock.calls[0]?.[0],
    ).toBeLessThan(
      vi.mocked(oneRowOscillators[1]!.frequency.exponentialRampToValueAtTime)
        .mock.calls[0]?.[0] as number,
    );
  });

  it("owns one quiet alternating Glitch preview loop and stops it on mute", async () => {
    vi.useFakeTimers();
    try {
      const context = fakeAudioContext();
      const engine = new AudioEngine({ contextFactory: () => context });
      expect(await engine.unlock()).toBe(true);

      expect(engine.startGlitchPreviewLoop({ pan: 0.4 })).toBe(true);
      expect(vi.mocked(context.createOscillator)).toHaveBeenCalledTimes(1);
      const first = vi.mocked(context.createOscillator).mock.results[0]?.value;
      expect(vi.mocked(first?.frequency.setValueAtTime).mock.calls[0]?.[0]).toBe(620);

      await vi.advanceTimersByTimeAsync(GLITCH_PREVIEW_STEP_MS);
      const second = vi.mocked(context.createOscillator).mock.results[1]?.value;
      expect(vi.mocked(second?.frequency.setValueAtTime).mock.calls[0]?.[0]).toBe(880);

      // Render loops may report the same primary preview repeatedly. Starting
      // again is idempotent rather than creating or restarting another owner.
      const beforeDuplicateStart = vi.mocked(context.createOscillator).mock.calls.length;
      expect(engine.startGlitchPreviewLoop()).toBe(true);
      expect(vi.mocked(context.createOscillator)).toHaveBeenCalledTimes(
        beforeDuplicateStart,
      );
      await vi.advanceTimersByTimeAsync(GLITCH_PREVIEW_STEP_MS);
      expect(vi.mocked(context.createOscillator)).toHaveBeenCalledTimes(
        beforeDuplicateStart + 1,
      );

      engine.setEffectsMuted(true);
      await vi.advanceTimersByTimeAsync(GLITCH_PREVIEW_STEP_MS * 2);
      expect(vi.mocked(context.createOscillator)).toHaveBeenCalledTimes(
        beforeDuplicateStart + 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins an already-cycling Glitch preview on its next visual boundary", async () => {
    vi.useFakeTimers();
    try {
      const context = fakeAudioContext();
      const engine = new AudioEngine({ contextFactory: () => context });
      expect(await engine.unlock()).toBe(true);

      // 375 ms is halfway through visual step 2. Do not emit a late tone for
      // that shape; wait 75 ms and sound step 3 exactly when the shape changes.
      expect(engine.startGlitchPreviewLoop({ elapsedMs: 375 })).toBe(true);
      expect(vi.mocked(context.createOscillator)).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(74);
      expect(vi.mocked(context.createOscillator)).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const joined = vi.mocked(context.createOscillator).mock.results[0]?.value;
      expect(vi.mocked(joined?.frequency.setValueAtTime).mock.calls[0]?.[0]).toBe(880);

      await vi.advanceTimersByTimeAsync(GLITCH_PREVIEW_STEP_MS);
      const following = vi.mocked(context.createOscillator).mock.results[1]?.value;
      expect(vi.mocked(following?.frequency.setValueAtTime).mock.calls[0]?.[0]).toBe(620);
      engine.stopGlitchPreviewLoop();
    } finally {
      vi.useRealTimers();
    }
  });
});
