import type { MonotonicClock } from "./clock";
import { isCriticalKind, type MessageKind } from "./messages";

export interface NetworkTelemetrySummary {
  channel: {
    generation: number;
    attached: boolean;
    ageMs?: number;
    firstRawFrameMs?: number;
    firstAuthenticatedFrameMs?: number;
  };
  receive: {
    rawFrames: number;
    rawBytes: number;
    decodedFrames: number;
    decodedBytes: number;
    authenticatedFrames: number;
    authenticatedBytes: number;
    rawAgeMs?: number;
    decodedAgeMs?: number;
    authenticatedAgeMs?: number;
  };
  send?: {
    frames: number;
    bytes: number;
    snapshots: number;
    keepalives: number;
    critical: number;
    other: number;
  };
  sinceAuthenticated: {
    sentFrames: number;
    sentBytes: number;
    receivedFrames: number;
    receivedBytes: number;
    sentSnapshots: number;
    sentKeepalives: number;
    sentCritical: number;
    sentOther: number;
    windowAgeMs?: number;
  };
  pump: {
    lastGapMs: number;
    maxGapMs: number;
    windowAgeMs?: number;
    maxGapSessionMs?: number;
  };
  snapshots: {
    accepted: number;
    gapEvents: number;
    missing: number;
    maxGap: number;
    lastSeq?: number;
  };
  critical: {
    pending: number;
    maxPending: number;
  };
}

export interface NetworkTelemetryOptions {
  clock?: MonotonicClock;
}

const systemClock: MonotonicClock = { now: () => Date.now() };

function increment(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

function decrement(value: number, amount = 1): number {
  return Math.max(0, value - amount);
}

function adjust(value: number, amount: number): number {
  return amount >= 0
    ? increment(value, amount)
    : decrement(value, -amount);
}

function requireCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCounter(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function optionalCounter(
  record: Record<string, unknown>,
  field: string,
): number | undefined | null {
  if (record[field] === undefined) return undefined;
  return readCounter(record[field]) ?? null;
}

/**
 * Rebuild a telemetry summary from untrusted persisted JSON. Unknown fields are
 * ignored so the v1 diagnostics schema can add optional telemetry fields later.
 */
export function parseNetworkTelemetrySummary(
  value: unknown,
): NetworkTelemetrySummary | undefined {
  if (!isRecord(value)) return undefined;
  const {
    channel,
    receive,
    send,
    sinceAuthenticated,
    pump,
    snapshots,
    critical,
  } = value;
  if (
    !isRecord(channel) ||
    !isRecord(receive) ||
    (send !== undefined && !isRecord(send)) ||
    !isRecord(sinceAuthenticated) ||
    !isRecord(pump) ||
    !isRecord(snapshots) ||
    !isRecord(critical)
  ) {
    return undefined;
  }

  const channelGeneration = readCounter(channel.generation);
  const channelAgeMs = optionalCounter(channel, "ageMs");
  const firstRawFrameMs = optionalCounter(channel, "firstRawFrameMs");
  const firstAuthenticatedFrameMs = optionalCounter(
    channel,
    "firstAuthenticatedFrameMs",
  );
  const rawFrames = readCounter(receive.rawFrames);
  const rawBytes = readCounter(receive.rawBytes);
  const decodedFrames = readCounter(receive.decodedFrames);
  const decodedBytes = readCounter(receive.decodedBytes);
  const authenticatedFrames = readCounter(receive.authenticatedFrames);
  const authenticatedBytes = readCounter(receive.authenticatedBytes);
  const rawAgeMs = optionalCounter(receive, "rawAgeMs");
  const decodedAgeMs = optionalCounter(receive, "decodedAgeMs");
  const authenticatedAgeMs = optionalCounter(receive, "authenticatedAgeMs");
  const totalSentFrames = send === undefined
    ? undefined
    : readCounter(send.frames);
  const totalSentBytes = send === undefined
    ? undefined
    : readCounter(send.bytes);
  const totalSentSnapshots = send === undefined
    ? undefined
    : readCounter(send.snapshots);
  const totalSentKeepalives = send === undefined
    ? undefined
    : readCounter(send.keepalives);
  const totalSentCritical = send === undefined
    ? undefined
    : readCounter(send.critical);
  const totalSentOther = send === undefined
    ? undefined
    : readCounter(send.other);
  const sentFrames = readCounter(sinceAuthenticated.sentFrames);
  const sentBytes = readCounter(sinceAuthenticated.sentBytes);
  const receivedFrames = readCounter(sinceAuthenticated.receivedFrames);
  const receivedBytes = readCounter(sinceAuthenticated.receivedBytes);
  const sentSnapshots = readCounter(sinceAuthenticated.sentSnapshots);
  const sentKeepalives = readCounter(sinceAuthenticated.sentKeepalives);
  const sentCritical = readCounter(sinceAuthenticated.sentCritical);
  const sentOther = readCounter(sinceAuthenticated.sentOther);
  const authenticatedWindowAgeMs = optionalCounter(
    sinceAuthenticated,
    "windowAgeMs",
  );
  const lastPumpGapMs = readCounter(pump.lastGapMs);
  const maxPumpGapMs = readCounter(pump.maxGapMs);
  const pumpWindowAgeMs = optionalCounter(pump, "windowAgeMs");
  const maxPumpGapSessionMs = optionalCounter(pump, "maxGapSessionMs");
  const acceptedSnapshots = readCounter(snapshots.accepted);
  const snapshotGapEvents = readCounter(snapshots.gapEvents);
  const missingSnapshots = readCounter(snapshots.missing);
  const maxSnapshotGap = readCounter(snapshots.maxGap);
  const lastSnapshotSeq = optionalCounter(snapshots, "lastSeq");
  const criticalPending = readCounter(critical.pending);
  const maxCriticalPending = readCounter(critical.maxPending);

  if (
    channelGeneration === undefined ||
    typeof channel.attached !== "boolean" ||
    channelAgeMs === null ||
    firstRawFrameMs === null ||
    firstAuthenticatedFrameMs === null ||
    rawFrames === undefined ||
    rawBytes === undefined ||
    decodedFrames === undefined ||
    decodedBytes === undefined ||
    authenticatedFrames === undefined ||
    authenticatedBytes === undefined ||
    rawAgeMs === null ||
    decodedAgeMs === null ||
    authenticatedAgeMs === null ||
    (send !== undefined &&
      (
        totalSentFrames === undefined ||
        totalSentBytes === undefined ||
        totalSentSnapshots === undefined ||
        totalSentKeepalives === undefined ||
        totalSentCritical === undefined ||
        totalSentOther === undefined
      )) ||
    sentFrames === undefined ||
    sentBytes === undefined ||
    receivedFrames === undefined ||
    receivedBytes === undefined ||
    sentSnapshots === undefined ||
    sentKeepalives === undefined ||
    sentCritical === undefined ||
    sentOther === undefined ||
    authenticatedWindowAgeMs === null ||
    lastPumpGapMs === undefined ||
    maxPumpGapMs === undefined ||
    pumpWindowAgeMs === null ||
    maxPumpGapSessionMs === null ||
    acceptedSnapshots === undefined ||
    snapshotGapEvents === undefined ||
    missingSnapshots === undefined ||
    maxSnapshotGap === undefined ||
    lastSnapshotSeq === null ||
    criticalPending === undefined ||
    maxCriticalPending === undefined
  ) {
    return undefined;
  }
  const profiledSentFrames =
    sentSnapshots + sentKeepalives + sentCritical + sentOther;
  const profiledTotalSentFrames =
    (totalSentSnapshots ?? 0) +
    (totalSentKeepalives ?? 0) +
    (totalSentCritical ?? 0) +
    (totalSentOther ?? 0);
  if (
    profiledSentFrames !== sentFrames ||
    (totalSentFrames !== undefined &&
      (
        profiledTotalSentFrames !== totalSentFrames ||
        totalSentFrames < sentFrames ||
        totalSentBytes! < sentBytes ||
        totalSentSnapshots! < sentSnapshots ||
        totalSentKeepalives! < sentKeepalives ||
        totalSentCritical! < sentCritical ||
        totalSentOther! < sentOther
      )) ||
    (maxPumpGapSessionMs !== undefined &&
      maxPumpGapSessionMs < maxPumpGapMs) ||
    decodedFrames > rawFrames ||
    authenticatedFrames > decodedFrames ||
    decodedBytes > rawBytes ||
    authenticatedBytes > decodedBytes ||
    criticalPending > maxCriticalPending ||
    snapshotGapEvents > acceptedSnapshots ||
    maxSnapshotGap > missingSnapshots ||
    (acceptedSnapshots === 0 && lastSnapshotSeq !== undefined) ||
    (acceptedSnapshots > 0 && lastSnapshotSeq === undefined)
  ) {
    return undefined;
  }

  return {
    channel: {
      generation: channelGeneration,
      attached: channel.attached,
      ...(channelAgeMs === undefined ? {} : { ageMs: channelAgeMs }),
      ...(firstRawFrameMs === undefined ? {} : { firstRawFrameMs }),
      ...(firstAuthenticatedFrameMs === undefined
        ? {}
        : { firstAuthenticatedFrameMs }),
    },
    receive: {
      rawFrames,
      rawBytes,
      decodedFrames,
      decodedBytes,
      authenticatedFrames,
      authenticatedBytes,
      ...(rawAgeMs === undefined ? {} : { rawAgeMs }),
      ...(decodedAgeMs === undefined ? {} : { decodedAgeMs }),
      ...(authenticatedAgeMs === undefined ? {} : { authenticatedAgeMs }),
    },
    ...(totalSentFrames === undefined
      ? {}
      : {
          send: {
            frames: totalSentFrames,
            bytes: totalSentBytes!,
            snapshots: totalSentSnapshots!,
            keepalives: totalSentKeepalives!,
            critical: totalSentCritical!,
            other: totalSentOther!,
          },
        }),
    sinceAuthenticated: {
      sentFrames,
      sentBytes,
      receivedFrames,
      receivedBytes,
      sentSnapshots,
      sentKeepalives,
      sentCritical,
      sentOther,
      ...(authenticatedWindowAgeMs === undefined
        ? {}
        : { windowAgeMs: authenticatedWindowAgeMs }),
    },
    pump: {
      lastGapMs: lastPumpGapMs,
      maxGapMs: maxPumpGapMs,
      ...(pumpWindowAgeMs === undefined
        ? {}
        : { windowAgeMs: pumpWindowAgeMs }),
      ...(maxPumpGapSessionMs === undefined
        ? {}
        : { maxGapSessionMs: maxPumpGapSessionMs }),
    },
    snapshots: {
      accepted: acceptedSnapshots,
      gapEvents: snapshotGapEvents,
      missing: missingSnapshots,
      maxGap: maxSnapshotGap,
      ...(lastSnapshotSeq === undefined ? {} : { lastSeq: lastSnapshotSeq }),
    },
    critical: {
      pending: criticalPending,
      maxPending: maxCriticalPending,
    },
  };
}

export function cloneNetworkTelemetrySummary(
  summary: NetworkTelemetrySummary,
): NetworkTelemetrySummary {
  return {
    channel: { ...summary.channel },
    receive: { ...summary.receive },
    ...(summary.send === undefined ? {} : { send: { ...summary.send } }),
    sinceAuthenticated: { ...summary.sinceAuthenticated },
    pump: { ...summary.pump },
    snapshots: { ...summary.snapshots },
    critical: { ...summary.critical },
  };
}

/**
 * Constant-space, allocation-free-on-the-hot-path network telemetry.
 *
 * `snapshot()` is intentionally the only operation that constructs a record.
 * Callers should capture it at incident transitions, not once per frame.
 */
export class NetworkTelemetry {
  private readonly clock: MonotonicClock;

  private channelGeneration = 0;
  private channelAttached = false;
  private channelAttachedAtMs: number | null = null;
  private channelDetachedAtMs: number | null = null;
  private firstRawFrameMs: number | null = null;
  private firstAuthenticatedFrameMs: number | null = null;

  private rawFrames = 0;
  private rawBytes = 0;
  private decodedFrames = 0;
  private decodedBytes = 0;
  private authenticatedFrames = 0;
  private authenticatedBytes = 0;
  private lastRawAtMs: number | null = null;
  private lastDecodedAtMs: number | null = null;
  private lastAuthenticatedAtMs: number | null = null;

  private sentFrames = 0;
  private sentBytes = 0;
  private sentSnapshots = 0;
  private sentKeepalives = 0;
  private sentCritical = 0;
  private sentOther = 0;

  private sentFramesSinceAuthenticated = 0;
  private sentBytesSinceAuthenticated = 0;
  private receivedFramesSinceAuthenticated = 0;
  private receivedBytesSinceAuthenticated = 0;
  private sentSnapshotsSinceAuthenticated = 0;
  private sentKeepalivesSinceAuthenticated = 0;
  private sentCriticalSinceAuthenticated = 0;
  private sentOtherSinceAuthenticated = 0;
  private sinceAuthenticatedWindowStartedAtMs: number | null = null;

  private lastPumpAtMs: number | null = null;
  private pumpWindowStartedAtMs: number | null = null;
  private lastPumpGapMs = 0;
  private maxPumpGapMs = 0;
  private maxPumpGapSessionMs = 0;

  private snapshotsAccepted = 0;
  private snapshotGapEvents = 0;
  private snapshotsMissing = 0;
  private maxSnapshotGap = 0;
  private lastSnapshotSeq: number | null = null;

  private criticalPending = 0;
  private maxCriticalPending = 0;

  public constructor(options: NetworkTelemetryOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  public noteChannelAttached(): void {
    const now = this.now();
    this.channelGeneration = increment(this.channelGeneration);
    this.channelAttached = true;
    this.channelAttachedAtMs = now;
    this.channelDetachedAtMs = null;
    this.firstRawFrameMs = null;
    this.firstAuthenticatedFrameMs = null;
    this.rawFrames = 0;
    this.rawBytes = 0;
    this.decodedFrames = 0;
    this.decodedBytes = 0;
    this.authenticatedFrames = 0;
    this.authenticatedBytes = 0;
    this.lastRawAtMs = null;
    this.lastDecodedAtMs = null;
    this.lastAuthenticatedAtMs = null;
  }

  public noteChannelDetached(): void {
    if (!this.channelAttached) return;
    this.channelAttached = false;
    this.channelDetachedAtMs = this.now();
  }

  /** Stage a frame before transport.send; pair a thrown send with noteSendFailed. */
  public noteSent(bytes: number, kind: MessageKind): void {
    requireCounter(bytes, "Sent byte count");
    this.sentFrames = increment(this.sentFrames);
    this.sentBytes = increment(this.sentBytes, bytes);
    this.sentFramesSinceAuthenticated = increment(
      this.sentFramesSinceAuthenticated,
    );
    this.sentBytesSinceAuthenticated = increment(
      this.sentBytesSinceAuthenticated,
      bytes,
    );
    this.adjustSentKinds(kind, 1);
  }

  /** Roll back a staged send when the transport rejects it by throwing. */
  public noteSendFailed(bytes: number, kind: MessageKind): void {
    requireCounter(bytes, "Rejected send byte count");
    this.sentFrames = decrement(this.sentFrames);
    this.sentBytes = decrement(this.sentBytes, bytes);
    this.sentFramesSinceAuthenticated = decrement(
      this.sentFramesSinceAuthenticated,
    );
    this.sentBytesSinceAuthenticated = decrement(
      this.sentBytesSinceAuthenticated,
      bytes,
    );
    this.adjustSentKinds(kind, -1);
  }

  /** Count every listener callback, before decoding or sender validation. */
  public noteRawReceived(bytes: number): void {
    requireCounter(bytes, "Received byte count");
    const now = this.now();
    this.rawFrames = increment(this.rawFrames);
    this.rawBytes = increment(this.rawBytes, bytes);
    this.receivedFramesSinceAuthenticated = increment(
      this.receivedFramesSinceAuthenticated,
    );
    this.receivedBytesSinceAuthenticated = increment(
      this.receivedBytesSinceAuthenticated,
      bytes,
    );
    this.lastRawAtMs = now;
    if (
      this.firstRawFrameMs === null &&
      this.channelAttachedAtMs !== null
    ) {
      this.firstRawFrameMs = this.elapsed(this.channelAttachedAtMs, now);
    }
  }

  /** Count frames that passed envelope decoding and match/sender validation. */
  public noteDecodedReceived(bytes: number): void {
    requireCounter(bytes, "Decoded byte count");
    const now = this.now();
    this.decodedFrames = increment(this.decodedFrames);
    this.decodedBytes = increment(this.decodedBytes, bytes);
    this.lastDecodedAtMs = now;
  }

  /**
   * Count a frame from the bound peer session. This begins a fresh traffic and
   * pump-gap window; the current frame remains in the per-channel receive totals.
   */
  public noteAuthenticatedReceived(bytes: number): void {
    requireCounter(bytes, "Authenticated byte count");
    const now = this.now();
    this.authenticatedFrames = increment(this.authenticatedFrames);
    this.authenticatedBytes = increment(this.authenticatedBytes, bytes);
    this.lastAuthenticatedAtMs = now;
    if (
      this.firstAuthenticatedFrameMs === null &&
      this.channelAttachedAtMs !== null
    ) {
      this.firstAuthenticatedFrameMs = this.elapsed(
        this.channelAttachedAtMs,
        now,
      );
    }
    this.resetTrafficWindow();
    this.sinceAuthenticatedWindowStartedAtMs = now;
    this.pumpWindowStartedAtMs = now;
    this.maxPumpGapMs = 0;
  }

  /** Sample the gameplay pump; the maximum covers only time since peer traffic. */
  public notePump(): void {
    const now = this.now();
    if (this.lastPumpAtMs === null) {
      this.lastPumpAtMs = now;
      if (this.pumpWindowStartedAtMs === null) this.pumpWindowStartedAtMs = now;
      return;
    }
    this.lastPumpGapMs = this.elapsed(this.lastPumpAtMs, now);
    this.maxPumpGapSessionMs = Math.max(
      this.maxPumpGapSessionMs,
      this.lastPumpGapMs,
    );
    const windowStart = Math.max(
      this.lastPumpAtMs,
      this.pumpWindowStartedAtMs ?? this.lastPumpAtMs,
    );
    this.maxPumpGapMs = Math.max(
      this.maxPumpGapMs,
      this.elapsed(windowStart, now),
    );
    this.lastPumpAtMs = now;
  }

  /** Count only snapshots accepted by the remote snapshot store. */
  public noteSnapshotAccepted(sequence: number): void {
    requireCounter(sequence, "Snapshot sequence");
    this.snapshotsAccepted = increment(this.snapshotsAccepted);
    if (
      this.lastSnapshotSeq !== null &&
      sequence > this.lastSnapshotSeq + 1
    ) {
      const missing = sequence - this.lastSnapshotSeq - 1;
      this.snapshotGapEvents = increment(this.snapshotGapEvents);
      this.snapshotsMissing = increment(this.snapshotsMissing, missing);
      this.maxSnapshotGap = Math.max(this.maxSnapshotGap, missing);
    }
    this.lastSnapshotSeq = Math.max(this.lastSnapshotSeq ?? 0, sequence);
  }

  /** Sample the current reliable outbox size and retain its session high-water mark. */
  public noteCriticalPending(count: number): void {
    requireCounter(count, "Critical pending count");
    this.criticalPending = count;
    this.maxCriticalPending = Math.max(this.maxCriticalPending, count);
  }

  public snapshot(): NetworkTelemetrySummary {
    const now = this.now();
    const channelEnd = this.channelAttached
      ? now
      : this.channelDetachedAtMs;
    return {
      channel: {
        generation: this.channelGeneration,
        attached: this.channelAttached,
        ...(this.channelAttachedAtMs === null || channelEnd === null
          ? {}
          : { ageMs: this.elapsed(this.channelAttachedAtMs, channelEnd) }),
        ...(this.firstRawFrameMs === null
          ? {}
          : { firstRawFrameMs: this.firstRawFrameMs }),
        ...(this.firstAuthenticatedFrameMs === null
          ? {}
          : { firstAuthenticatedFrameMs: this.firstAuthenticatedFrameMs }),
      },
      receive: {
        rawFrames: this.rawFrames,
        rawBytes: this.rawBytes,
        decodedFrames: this.decodedFrames,
        decodedBytes: this.decodedBytes,
        authenticatedFrames: this.authenticatedFrames,
        authenticatedBytes: this.authenticatedBytes,
        ...(this.lastRawAtMs === null
          ? {}
          : { rawAgeMs: this.elapsed(this.lastRawAtMs, now) }),
        ...(this.lastDecodedAtMs === null
          ? {}
          : { decodedAgeMs: this.elapsed(this.lastDecodedAtMs, now) }),
        ...(this.lastAuthenticatedAtMs === null
          ? {}
          : {
              authenticatedAgeMs: this.elapsed(
                this.lastAuthenticatedAtMs,
                now,
              ),
            }),
      },
      send: {
        frames: this.sentFrames,
        bytes: this.sentBytes,
        snapshots: this.sentSnapshots,
        keepalives: this.sentKeepalives,
        critical: this.sentCritical,
        other: this.sentOther,
      },
      sinceAuthenticated: {
        sentFrames: this.sentFramesSinceAuthenticated,
        sentBytes: this.sentBytesSinceAuthenticated,
        receivedFrames: this.receivedFramesSinceAuthenticated,
        receivedBytes: this.receivedBytesSinceAuthenticated,
        sentSnapshots: this.sentSnapshotsSinceAuthenticated,
        sentKeepalives: this.sentKeepalivesSinceAuthenticated,
        sentCritical: this.sentCriticalSinceAuthenticated,
        sentOther: this.sentOtherSinceAuthenticated,
        ...(this.sinceAuthenticatedWindowStartedAtMs === null
          ? {}
          : {
              windowAgeMs: this.elapsed(
                this.sinceAuthenticatedWindowStartedAtMs,
                now,
              ),
            }),
      },
      pump: {
        lastGapMs: this.lastPumpGapMs,
        maxGapMs: this.maxPumpGapMs,
        ...(this.pumpWindowStartedAtMs === null
          ? {}
          : {
              windowAgeMs: this.elapsed(
                this.pumpWindowStartedAtMs,
                now,
              ),
            }),
        maxGapSessionMs: this.maxPumpGapSessionMs,
      },
      snapshots: {
        accepted: this.snapshotsAccepted,
        gapEvents: this.snapshotGapEvents,
        missing: this.snapshotsMissing,
        maxGap: this.maxSnapshotGap,
        ...(this.lastSnapshotSeq === null
          ? {}
          : { lastSeq: this.lastSnapshotSeq }),
      },
      critical: {
        pending: this.criticalPending,
        maxPending: this.maxCriticalPending,
      },
    };
  }

  private resetTrafficWindow(): void {
    this.sentFramesSinceAuthenticated = 0;
    this.sentBytesSinceAuthenticated = 0;
    this.receivedFramesSinceAuthenticated = 0;
    this.receivedBytesSinceAuthenticated = 0;
    this.sentSnapshotsSinceAuthenticated = 0;
    this.sentKeepalivesSinceAuthenticated = 0;
    this.sentCriticalSinceAuthenticated = 0;
    this.sentOtherSinceAuthenticated = 0;
  }

  private adjustSentKinds(kind: MessageKind, amount: 1 | -1): void {
    if (kind === "SNAPSHOT") {
      this.sentSnapshots = adjust(this.sentSnapshots, amount);
      this.sentSnapshotsSinceAuthenticated = adjust(
        this.sentSnapshotsSinceAuthenticated,
        amount,
      );
    } else if (kind === "KEEPALIVE") {
      this.sentKeepalives = adjust(this.sentKeepalives, amount);
      this.sentKeepalivesSinceAuthenticated = adjust(
        this.sentKeepalivesSinceAuthenticated,
        amount,
      );
    } else if (isCriticalKind(kind)) {
      this.sentCritical = adjust(this.sentCritical, amount);
      this.sentCriticalSinceAuthenticated = adjust(
        this.sentCriticalSinceAuthenticated,
        amount,
      );
    } else {
      this.sentOther = adjust(this.sentOther, amount);
      this.sentOtherSinceAuthenticated = adjust(
        this.sentOtherSinceAuthenticated,
        amount,
      );
    }
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("Network telemetry timestamps must be non-negative");
    }
    return Math.floor(now);
  }

  private elapsed(startMs: number, endMs: number): number {
    return Math.max(0, endMs - startMs);
  }
}
