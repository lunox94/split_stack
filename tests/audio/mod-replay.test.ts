import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ModReplay } from "../../src/audio/mod-replay";

const SAMPLE_RATE = 44_100;

interface PatternCell {
  readonly row: number;
  readonly channel?: number;
  readonly sample?: number;
  readonly period?: number;
  readonly effect?: number;
  readonly parameter?: number;
}

function makeModule(cells: readonly PatternCell[] = []): ArrayBuffer {
  const sample = Int8Array.from([127, 64, 0, -64, -128, -64, 0, 64]);
  const bytes = new Uint8Array(1_084 + 1_024 + sample.length);
  const writeAscii = (offset: number, value: string, length: number): void => {
    for (let index = 0; index < Math.min(value.length, length); index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  const writeU16 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 8) & 0xff;
    bytes[offset + 1] = value & 0xff;
  };

  writeAscii(0, "Replay fixture", 20);
  writeAscii(20, "looped waveform", 22);
  writeU16(42, sample.length / 2);
  bytes[45] = 64;
  writeU16(46, 0);
  writeU16(48, sample.length / 2);
  bytes[950] = 1;
  bytes[951] = 0;
  bytes[952] = 0;
  writeAscii(1_080, "M.K.", 4);

  for (const cell of cells) {
    const channel = cell.channel ?? 0;
    const sampleNumber = cell.sample ?? 0;
    const period = cell.period ?? 0;
    const effect = cell.effect ?? 0;
    const parameter = cell.parameter ?? 0;
    const offset = 1_084 + (cell.row * 4 + channel) * 4;
    bytes[offset] = (sampleNumber & 0xf0) | ((period >>> 8) & 0x0f);
    bytes[offset + 1] = period & 0xff;
    bytes[offset + 2] = ((sampleNumber & 0x0f) << 4) | (effect & 0x0f);
    bytes[offset + 3] = parameter;
  }
  bytes.set(new Uint8Array(sample.buffer), 1_084 + 1_024);
  return bytes.buffer;
}

describe("MOD replay", () => {
  it.each([
    ["bloody_tears.mod", "bloody tears", 2_752_512],
    ["radix-mountain_king.mod", "mountain king", 3_279_276],
    ["flight_of_bumble_bee.mod", "Flight of bumble bee", 3_669_120],
    ["galaxy_-_popcorn.mod", "popcorn", 4_974_480],
  ] as const)(
    "renders the bundled %s module with its authored duration",
    (fileName, title, durationSamples) => {
      const replay = new ModReplay(
        readFileSync(resolve("public/music", fileName)),
        SAMPLE_RATE,
      );
      const left = new Float32Array(8_192);
      const right = new Float32Array(8_192);

      replay.render(left, right);

      expect(replay.songName).toBe(title);
      expect(replay.durationSamples).toBe(durationSamples);
      expect(left.every(Number.isFinite)).toBe(true);
      expect(right.every(Number.isFinite)).toBe(true);
      expect(
        left.some((sample) => sample !== 0) || right.some((sample) => sample !== 0),
      ).toBe(true);
    },
  );

  it("parses metadata and renders a ProTracker module through one public seam", () => {
    const replay = new ModReplay(
      makeModule([{ row: 0, sample: 1, period: 428 }]),
      SAMPLE_RATE,
    );
    const left = new Float32Array(8_192);
    const right = new Float32Array(8_192);

    replay.render(left, right);

    expect(replay.songName).toBe("Replay fixture");
    expect(replay.durationSamples).toBe(338_688);
    expect(left.some((sample) => sample !== 0)).toBe(true);
    expect(right.some((sample) => sample !== 0)).toBe(true);
    expect(left.every(Number.isFinite)).toBe(true);
    expect(right.every(Number.isFinite)).toBe(true);
  });

  it("resets deterministically and seeks to a sample position", () => {
    const replay = new ModReplay(
      makeModule([{ row: 0, sample: 1, period: 428 }]),
      SAMPLE_RATE,
    );
    const sequentialLeft = new Float32Array(12_288);
    const sequentialRight = new Float32Array(12_288);
    replay.render(sequentialLeft, sequentialRight);

    replay.reset();
    const resetLeft = new Float32Array(4_096);
    const resetRight = new Float32Array(4_096);
    replay.render(resetLeft, resetRight);
    expect(resetLeft).toEqual(sequentialLeft.slice(0, 4_096));
    expect(resetRight).toEqual(sequentialRight.slice(0, 4_096));
    expect(replay.positionSamples).toBe(4_096);

    expect(replay.seek(4_096)).toBe(4_096);
    const soughtLeft = new Float32Array(4_096);
    const soughtRight = new Float32Array(4_096);
    replay.render(soughtLeft, soughtRight);

    // Seeking resets Micromod's short anti-click ramp. Once that 64-sample
    // ramp is past, the PCM must match uninterrupted playback exactly.
    expect(soughtLeft.slice(64)).toEqual(sequentialLeft.slice(4_160, 8_192));
    expect(soughtRight.slice(64)).toEqual(sequentialRight.slice(4_160, 8_192));
    expect(replay.positionSamples).toBe(8_192);
  });

  it("applies ProTracker speed and volume commands", () => {
    const faster = new ModReplay(
      makeModule([
        { row: 0, sample: 1, period: 428, effect: 0x0f, parameter: 0x03 },
      ]),
      SAMPLE_RATE,
    );
    expect(faster.durationSamples).toBe(169_344);

    const muted = new ModReplay(
      makeModule([
        { row: 0, sample: 1, period: 428, effect: 0x0c, parameter: 0x00 },
      ]),
      SAMPLE_RATE,
    );
    const left = new Float32Array(8_192);
    const right = new Float32Array(8_192);
    muted.render(left, right);
    expect(left.every((sample) => sample === 0)).toBe(true);
    expect(right.every((sample) => sample === 0)).toBe(true);
  });

  it("replays the remaining effect commands used by the selected modules", () => {
    const replay = new ModReplay(
      makeModule([
        { row: 0, sample: 1, period: 428 },
        { row: 1, effect: 0x0a, parameter: 0x01 },
        { row: 2, effect: 0x02, parameter: 0x1d },
        { row: 3, period: 381, effect: 0x03, parameter: 0x10 },
        { row: 4, effect: 0x04, parameter: 0x81 },
        { row: 5, effect: 0x06, parameter: 0x01 },
        { row: 6, effect: 0x0e, parameter: 0xb2 },
        { row: 7, sample: 1, period: 428, effect: 0x09, parameter: 0x00 },
        { row: 8, effect: 0x0e, parameter: 0x93 },
        { row: 9, effect: 0x0d, parameter: 0x00 },
      ]),
      SAMPLE_RATE,
    );
    const firstLeft = new Float32Array(48_000);
    const firstRight = new Float32Array(48_000);
    replay.render(firstLeft, firstRight);
    replay.reset();
    const secondLeft = new Float32Array(48_000);
    const secondRight = new Float32Array(48_000);
    replay.render(secondLeft, secondRight);

    expect(firstLeft.some((sample) => sample !== 0)).toBe(true);
    expect(firstLeft.every(Number.isFinite)).toBe(true);
    expect(firstRight.every(Number.isFinite)).toBe(true);
    expect(secondLeft).toEqual(firstLeft);
    expect(secondRight).toEqual(firstRight);
  });

  it("rejects truncated modules and invalid output buffers", () => {
    expect(() => new ModReplay(new ArrayBuffer(32), SAMPLE_RATE)).toThrow(
      "MOD data is truncated",
    );

    const replay = new ModReplay(makeModule(), SAMPLE_RATE);
    expect(() =>
      replay.render(new Float32Array(8), new Float32Array(7)),
    ).toThrow("same length");
    expect(() => replay.seek(Number.NaN)).toThrow("must be finite");
  });
});
