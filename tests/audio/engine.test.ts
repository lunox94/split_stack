import { describe, expect, it, vi } from "vitest";

import { AudioEngine } from "../../src/audio/engine";

function fakeAudioContext(): AudioContext & {
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
    createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(64) })),
    close: vi.fn(async () => {
      context.state = "closed";
    }),
    resume: vi.fn(async () => {
      context.state = "running";
    }),
  };
  return context as unknown as AudioContext & {
    state: AudioContextState;
    resume: ReturnType<typeof vi.fn>;
  };
}

describe("audio engine lifecycle", () => {
  it("resumes a suspended audio context before restarting paused music", async () => {
    const context = fakeAudioContext();
    const engine = new AudioEngine({ contextFactory: () => context });
    expect(await engine.unlock()).toBe(true);
    engine.startMenuMusic();
    engine.pauseMusic();
    context.state = "suspended";

    engine.resumeMusic();
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());
    engine.updateMusic();

    expect(context.state).toBe("running");
    expect(context.createOscillator).toHaveBeenCalled();
  });

  it("does not schedule inaudible sources while either audio bus is muted", async () => {
    const context = fakeAudioContext();
    const engine = new AudioEngine({ contextFactory: () => context });
    expect(await engine.unlock()).toBe(true);
    engine.startMenuMusic();
    engine.setMusicMuted(true);

    engine.updateMusic();
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(context.createBufferSource).not.toHaveBeenCalled();

    engine.setMusicMuted(false);
    engine.updateMusic();
    expect(context.createOscillator).toHaveBeenCalled();

    vi.mocked(context.createOscillator).mockClear();
    engine.setEffectsMuted(true);
    engine.play("move");
    expect(context.createOscillator).not.toHaveBeenCalled();

    engine.setEffectsMuted(false);
    engine.play("move");
    expect(context.createOscillator).toHaveBeenCalled();
  });
});
