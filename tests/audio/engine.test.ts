import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AudioEngine } from "../../src/audio/engine";

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
});
