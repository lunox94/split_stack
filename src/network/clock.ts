import type { Tick } from "../domain/types";

// Transport-only clock probe policy. These values do not change deterministic
// gameplay and intentionally sit outside the hashed rules contract.
export const CLOCK_SYNC_SAMPLE_TARGET = 5;
export const CLOCK_SYNC_RETRY_BASE_MS = 500;
export const CLOCK_SYNC_RETRY_MAX_MS = 2_000;

export interface MonotonicClock {
  now(): number;
}

export interface ClockSample {
  sampleId: number;
  roundTripMs: number;
  offsetPeerMinusCoordinatorMs: number;
}

export interface ClockSelection {
  offsetPeerMinusCoordinatorMs: number;
  selectedSampleIds: number[];
}

function assertTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Clock timestamps must be finite non-negative numbers");
  }
}

export function calculateClockSample(
  coordinatorSentMs: number,
  peerReceivedMs: number,
  peerSentMs: number,
  coordinatorReceivedMs: number,
  sampleId: number,
): ClockSample {
  for (const timestamp of [
    coordinatorSentMs,
    peerReceivedMs,
    peerSentMs,
    coordinatorReceivedMs,
  ]) {
    assertTimestamp(timestamp);
  }
  if (
    !Number.isSafeInteger(sampleId) ||
    sampleId < 0 ||
    peerSentMs < peerReceivedMs ||
    coordinatorReceivedMs < coordinatorSentMs
  ) {
    throw new RangeError("Clock timestamp order or sample ID is invalid");
  }

  const roundTripMs =
    coordinatorReceivedMs -
    coordinatorSentMs -
    (peerSentMs - peerReceivedMs);
  if (roundTripMs < 0) {
    throw new RangeError("Clock timestamp processing interval exceeds round trip");
  }

  return {
    sampleId,
    roundTripMs,
    offsetPeerMinusCoordinatorMs:
      ((peerReceivedMs - coordinatorSentMs) +
        (peerSentMs - coordinatorReceivedMs)) /
      2,
  };
}

export function selectClockOffset(samples: readonly ClockSample[]): ClockSelection {
  if (samples.length !== CLOCK_SYNC_SAMPLE_TARGET) {
    throw new RangeError("Clock synchronization requires exactly five samples");
  }
  if (
    new Set(samples.map((sample) => sample.sampleId)).size !==
    CLOCK_SYNC_SAMPLE_TARGET
  ) {
    throw new RangeError("Clock synchronization requires five distinct sample IDs");
  }
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.sampleId) ||
      sample.sampleId < 0 ||
      !Number.isFinite(sample.roundTripMs) ||
      sample.roundTripMs < 0 ||
      !Number.isFinite(sample.offsetPeerMinusCoordinatorMs)
    ) {
      throw new RangeError("Invalid clock sample");
    }
  }

  const selected = [...samples]
    .sort(
      (left, right) =>
        left.roundTripMs - right.roundTripMs || left.sampleId - right.sampleId,
    )
    .slice(0, 3);
  const offsets = selected
    .map((sample) => sample.offsetPeerMinusCoordinatorMs)
    .sort((left, right) => left - right);
  const median = offsets[1];
  if (median === undefined) throw new Error("Clock sample selection failed");

  return {
    offsetPeerMinusCoordinatorMs: median,
    selectedSampleIds: selected.map((sample) => sample.sampleId),
  };
}

/**
 * Maps a synchronized monotonic epoch to the fixed-step simulation clock.
 * Network deadlines use their own monotonic clock; this class never reads wall time.
 */
export class MatchTickClock {
  private startMonotonicMs: number | null = null;
  private startTick: Tick = 0;
  private pausedTick: Tick | null = 0;

  public constructor(private readonly ticksPerSecond: number) {
    if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
      throw new RangeError("Tick frequency must be positive");
    }
  }

  public scheduleStart(startMonotonicMs: number, startTick: Tick = 0): void {
    assertTimestamp(startMonotonicMs);
    if (!Number.isSafeInteger(startTick) || startTick < 0) {
      throw new RangeError("Start tick must be a non-negative integer");
    }
    this.startMonotonicMs = startMonotonicMs;
    this.startTick = startTick;
    this.pausedTick = null;
  }

  public tickAt(monotonicMs: number): Tick {
    assertTimestamp(monotonicMs);
    if (this.pausedTick !== null) return this.pausedTick;
    if (this.startMonotonicMs === null) return this.startTick;
    const elapsedMs = Math.max(0, monotonicMs - this.startMonotonicMs);
    return this.startTick + Math.floor((elapsedMs * this.ticksPerSecond) / 1_000);
  }

  public pauseAt(monotonicMs: number): Tick {
    const tick = this.tickAt(monotonicMs);
    this.pausedTick = tick;
    this.startMonotonicMs = null;
    this.startTick = tick;
    return tick;
  }

  public scheduleResume(startMonotonicMs: number): void {
    this.scheduleStart(startMonotonicMs, this.pausedTick ?? this.startTick);
  }
}
