import type { MonotonicClock } from "./clock";
import { isCriticalKind, type MessageKind } from "./messages";

export interface NetworkTimingSummary {
  samples: number;
  latestMs?: number;
  minMs?: number;
  maxMs?: number;
  smoothedMs?: number;
  jitterMs?: number;
}

export interface NetworkReceiveTotals {
  rawFrames: number;
  rawBytes: number;
  decodedFrames: number;
  decodedBytes: number;
  authenticatedFrames: number;
  authenticatedBytes: number;
}

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
  /** Session-wide receive totals; unlike `receive`, these survive channel replacement. */
  receiveSession?: NetworkReceiveTotals;
  send?: {
    frames: number;
    bytes: number;
    snapshots: number;
    keepalives: number;
    critical: number;
    other: number;
    bytesByKind?: {
      snapshots: number;
      keepalives: number;
      critical: number;
      other: number;
    };
    failed?: {
      frames: number;
      bytes: number;
    };
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
  rtt?: NetworkTimingSummary;
  authenticatedInterarrival?: NetworkTimingSummary;
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
    retransmits?: number;
    gapRequests?: number;
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

function readTimingSummary(value: unknown): NetworkTimingSummary | undefined {
  if (!isRecord(value)) return undefined;
  const samples = readCounter(value.samples);
  const latestMs = optionalCounter(value, "latestMs");
  const minMs = optionalCounter(value, "minMs");
  const maxMs = optionalCounter(value, "maxMs");
  const smoothedMs = optionalCounter(value, "smoothedMs");
  const jitterMs = optionalCounter(value, "jitterMs");
  if (
    samples === undefined ||
    latestMs === null ||
    minMs === null ||
    maxMs === null ||
    smoothedMs === null ||
    jitterMs === null
  ) {
    return undefined;
  }
  const populated = [latestMs, minMs, maxMs, smoothedMs, jitterMs].filter(
    (measurement) => measurement !== undefined,
  ).length;
  if (
    (samples === 0 && populated !== 0) ||
    (samples > 0 && populated !== 5) ||
    (samples > 0 && minMs! > maxMs!) ||
    (samples > 0 && (latestMs! < minMs! || latestMs! > maxMs!))
  ) {
    return undefined;
  }
  return {
    samples,
    ...(latestMs === undefined ? {} : { latestMs }),
    ...(minMs === undefined ? {} : { minMs }),
    ...(maxMs === undefined ? {} : { maxMs }),
    ...(smoothedMs === undefined ? {} : { smoothedMs }),
    ...(jitterMs === undefined ? {} : { jitterMs }),
  };
}

interface TimingAccumulator {
  samples: number;
  latestMs: number;
  minMs: number;
  maxMs: number;
  smoothedMs: number;
  jitterMs: number;
}

function createTimingAccumulator(): TimingAccumulator {
  return {
    samples: 0,
    latestMs: 0,
    minMs: 0,
    maxMs: 0,
    smoothedMs: 0,
    jitterMs: 0,
  };
}

function noteTimingSample(
  accumulator: TimingAccumulator,
  milliseconds: number,
): void {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError("Network timing samples must be finite non-negative values");
  }
  if (accumulator.samples === 0) {
    accumulator.samples = 1;
    accumulator.latestMs = milliseconds;
    accumulator.minMs = milliseconds;
    accumulator.maxMs = milliseconds;
    accumulator.smoothedMs = milliseconds;
    accumulator.jitterMs = 0;
    return;
  }
  const deviation = Math.abs(accumulator.smoothedMs - milliseconds);
  accumulator.jitterMs += (deviation - accumulator.jitterMs) / 4;
  accumulator.smoothedMs += (milliseconds - accumulator.smoothedMs) / 8;
  accumulator.samples = increment(accumulator.samples);
  accumulator.latestMs = milliseconds;
  accumulator.minMs = Math.min(accumulator.minMs, milliseconds);
  accumulator.maxMs = Math.max(accumulator.maxMs, milliseconds);
}

function timingSummary(accumulator: TimingAccumulator): NetworkTimingSummary {
  if (accumulator.samples === 0) return { samples: 0 };
  return {
    samples: accumulator.samples,
    latestMs: Math.round(accumulator.latestMs),
    minMs: Math.round(accumulator.minMs),
    maxMs: Math.round(accumulator.maxMs),
    smoothedMs: Math.round(accumulator.smoothedMs),
    jitterMs: Math.round(accumulator.jitterMs),
  };
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
    receiveSession,
    send,
    sinceAuthenticated,
    pump,
    rtt,
    authenticatedInterarrival,
    snapshots,
    critical,
  } = value;
  if (
    !isRecord(channel) ||
    !isRecord(receive) ||
    (receiveSession !== undefined && !isRecord(receiveSession)) ||
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
  const sessionRawFrames = receiveSession === undefined
    ? undefined
    : readCounter(receiveSession.rawFrames);
  const sessionRawBytes = receiveSession === undefined
    ? undefined
    : readCounter(receiveSession.rawBytes);
  const sessionDecodedFrames = receiveSession === undefined
    ? undefined
    : readCounter(receiveSession.decodedFrames);
  const sessionDecodedBytes = receiveSession === undefined
    ? undefined
    : readCounter(receiveSession.decodedBytes);
  const sessionAuthenticatedFrames = receiveSession === undefined
    ? undefined
    : readCounter(receiveSession.authenticatedFrames);
  const sessionAuthenticatedBytes = receiveSession === undefined
    ? undefined
    : readCounter(receiveSession.authenticatedBytes);
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
  const sentBytesByKind = send?.bytesByKind;
  const sentSnapshotBytes = sentBytesByKind === undefined || !isRecord(sentBytesByKind)
    ? undefined
    : readCounter(sentBytesByKind.snapshots);
  const sentKeepaliveBytes = sentBytesByKind === undefined || !isRecord(sentBytesByKind)
    ? undefined
    : readCounter(sentBytesByKind.keepalives);
  const sentCriticalBytes = sentBytesByKind === undefined || !isRecord(sentBytesByKind)
    ? undefined
    : readCounter(sentBytesByKind.critical);
  const sentOtherBytes = sentBytesByKind === undefined || !isRecord(sentBytesByKind)
    ? undefined
    : readCounter(sentBytesByKind.other);
  const failedSend = send?.failed;
  const failedSendFrames = failedSend === undefined || !isRecord(failedSend)
    ? undefined
    : readCounter(failedSend.frames);
  const failedSendBytes = failedSend === undefined || !isRecord(failedSend)
    ? undefined
    : readCounter(failedSend.bytes);
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
  const rttSummary = rtt === undefined ? undefined : readTimingSummary(rtt);
  const authenticatedInterarrivalSummary = authenticatedInterarrival === undefined
    ? undefined
    : readTimingSummary(authenticatedInterarrival);
  const acceptedSnapshots = readCounter(snapshots.accepted);
  const snapshotGapEvents = readCounter(snapshots.gapEvents);
  const missingSnapshots = readCounter(snapshots.missing);
  const maxSnapshotGap = readCounter(snapshots.maxGap);
  const lastSnapshotSeq = optionalCounter(snapshots, "lastSeq");
  const criticalPending = readCounter(critical.pending);
  const maxCriticalPending = readCounter(critical.maxPending);
  const criticalRetransmits = optionalCounter(critical, "retransmits");
  const criticalGapRequests = optionalCounter(critical, "gapRequests");

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
    (receiveSession !== undefined &&
      (
        sessionRawFrames === undefined ||
        sessionRawBytes === undefined ||
        sessionDecodedFrames === undefined ||
        sessionDecodedBytes === undefined ||
        sessionAuthenticatedFrames === undefined ||
        sessionAuthenticatedBytes === undefined
      )) ||
    (send !== undefined &&
      (
        totalSentFrames === undefined ||
        totalSentBytes === undefined ||
        totalSentSnapshots === undefined ||
        totalSentKeepalives === undefined ||
        totalSentCritical === undefined ||
        totalSentOther === undefined
      )) ||
    (send !== undefined && send.bytesByKind !== undefined &&
      (
        !isRecord(send.bytesByKind) ||
        sentSnapshotBytes === undefined ||
        sentKeepaliveBytes === undefined ||
        sentCriticalBytes === undefined ||
        sentOtherBytes === undefined
      )) ||
    (send !== undefined && send.failed !== undefined &&
      (
        !isRecord(send.failed) ||
        failedSendFrames === undefined ||
        failedSendBytes === undefined
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
    (rtt !== undefined && rttSummary === undefined) ||
    (authenticatedInterarrival !== undefined &&
      authenticatedInterarrivalSummary === undefined) ||
    acceptedSnapshots === undefined ||
    snapshotGapEvents === undefined ||
    missingSnapshots === undefined ||
    maxSnapshotGap === undefined ||
    lastSnapshotSeq === null ||
    criticalPending === undefined ||
    maxCriticalPending === undefined ||
    criticalRetransmits === null ||
    criticalGapRequests === null
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
  const profiledTotalSentBytes =
    (sentSnapshotBytes ?? 0) +
    (sentKeepaliveBytes ?? 0) +
    (sentCriticalBytes ?? 0) +
    (sentOtherBytes ?? 0);
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
    (sentSnapshotBytes !== undefined &&
      (
        !Number.isSafeInteger(profiledTotalSentBytes) ||
        profiledTotalSentBytes !== totalSentBytes
      )) ||
    (maxPumpGapSessionMs !== undefined &&
      maxPumpGapSessionMs < maxPumpGapMs) ||
    decodedFrames > rawFrames ||
    authenticatedFrames > decodedFrames ||
    decodedBytes > rawBytes ||
    authenticatedBytes > decodedBytes ||
    (sessionRawFrames !== undefined &&
      (
        sessionRawFrames < rawFrames ||
        sessionRawBytes! < rawBytes ||
        sessionDecodedFrames! < decodedFrames ||
        sessionDecodedBytes! < decodedBytes ||
        sessionAuthenticatedFrames! < authenticatedFrames ||
        sessionAuthenticatedBytes! < authenticatedBytes ||
        sessionDecodedFrames! > sessionRawFrames ||
        sessionAuthenticatedFrames! > sessionDecodedFrames! ||
        sessionDecodedBytes! > sessionRawBytes! ||
        sessionAuthenticatedBytes! > sessionDecodedBytes!
      )) ||
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
    ...(sessionRawFrames === undefined
      ? {}
      : {
          receiveSession: {
            rawFrames: sessionRawFrames,
            rawBytes: sessionRawBytes!,
            decodedFrames: sessionDecodedFrames!,
            decodedBytes: sessionDecodedBytes!,
            authenticatedFrames: sessionAuthenticatedFrames!,
            authenticatedBytes: sessionAuthenticatedBytes!,
          },
        }),
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
            ...(sentSnapshotBytes === undefined
              ? {}
              : {
                  bytesByKind: {
                    snapshots: sentSnapshotBytes,
                    keepalives: sentKeepaliveBytes!,
                    critical: sentCriticalBytes!,
                    other: sentOtherBytes!,
                  },
                }),
            ...(failedSendFrames === undefined
              ? {}
              : {
                  failed: {
                    frames: failedSendFrames,
                    bytes: failedSendBytes!,
                  },
                }),
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
    ...(rttSummary === undefined ? {} : { rtt: rttSummary }),
    ...(authenticatedInterarrivalSummary === undefined
      ? {}
      : { authenticatedInterarrival: authenticatedInterarrivalSummary }),
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
      ...(criticalRetransmits === undefined
        ? {}
        : { retransmits: criticalRetransmits }),
      ...(criticalGapRequests === undefined
        ? {}
        : { gapRequests: criticalGapRequests }),
    },
  };
}

export function cloneNetworkTelemetrySummary(
  summary: NetworkTelemetrySummary,
): NetworkTelemetrySummary {
  return {
    channel: { ...summary.channel },
    receive: { ...summary.receive },
    ...(summary.receiveSession === undefined
      ? {}
      : { receiveSession: { ...summary.receiveSession } }),
    ...(summary.send === undefined
      ? {}
      : {
          send: {
            ...summary.send,
            ...(summary.send.bytesByKind === undefined
              ? {}
              : { bytesByKind: { ...summary.send.bytesByKind } }),
            ...(summary.send.failed === undefined
              ? {}
              : { failed: { ...summary.send.failed } }),
          },
        }),
    sinceAuthenticated: { ...summary.sinceAuthenticated },
    pump: { ...summary.pump },
    ...(summary.rtt === undefined ? {} : { rtt: { ...summary.rtt } }),
    ...(summary.authenticatedInterarrival === undefined
      ? {}
      : {
          authenticatedInterarrival: {
            ...summary.authenticatedInterarrival,
          },
        }),
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

  private sessionRawFrames = 0;
  private sessionRawBytes = 0;
  private sessionDecodedFrames = 0;
  private sessionDecodedBytes = 0;
  private sessionAuthenticatedFrames = 0;
  private sessionAuthenticatedBytes = 0;
  private lastSessionAuthenticatedAtMs: number | null = null;
  private readonly authenticatedInterarrival = createTimingAccumulator();

  private sentFrames = 0;
  private sentBytes = 0;
  private sentSnapshots = 0;
  private sentKeepalives = 0;
  private sentCritical = 0;
  private sentOther = 0;
  private sentSnapshotBytes = 0;
  private sentKeepaliveBytes = 0;
  private sentCriticalBytes = 0;
  private sentOtherBytes = 0;
  private failedSendFrames = 0;
  private failedSendBytes = 0;

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

  private readonly roundTrip = createTimingAccumulator();

  private snapshotsAccepted = 0;
  private snapshotGapEvents = 0;
  private snapshotsMissing = 0;
  private maxSnapshotGap = 0;
  private lastSnapshotSeq: number | null = null;

  private criticalPending = 0;
  private maxCriticalPending = 0;
  private criticalRetransmits = 0;
  private criticalGapRequests = 0;

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
    this.adjustSentKind(kind, 1, bytes);
  }

  /** Roll back a staged send when the transport rejects it by throwing. */
  public noteSendFailed(bytes: number, kind: MessageKind): void {
    requireCounter(bytes, "Rejected send byte count");
    this.failedSendFrames = increment(this.failedSendFrames);
    this.failedSendBytes = increment(this.failedSendBytes, bytes);
    this.sentFrames = decrement(this.sentFrames);
    this.sentBytes = decrement(this.sentBytes, bytes);
    this.sentFramesSinceAuthenticated = decrement(
      this.sentFramesSinceAuthenticated,
    );
    this.sentBytesSinceAuthenticated = decrement(
      this.sentBytesSinceAuthenticated,
      bytes,
    );
    this.adjustSentKind(kind, -1, -bytes);
  }

  /** Count every listener callback, before decoding or sender validation. */
  public noteRawReceived(bytes: number): void {
    requireCounter(bytes, "Received byte count");
    const now = this.now();
    this.rawFrames = increment(this.rawFrames);
    this.rawBytes = increment(this.rawBytes, bytes);
    this.sessionRawFrames = increment(this.sessionRawFrames);
    this.sessionRawBytes = increment(this.sessionRawBytes, bytes);
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
    this.sessionDecodedFrames = increment(this.sessionDecodedFrames);
    this.sessionDecodedBytes = increment(this.sessionDecodedBytes, bytes);
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
    this.sessionAuthenticatedFrames = increment(this.sessionAuthenticatedFrames);
    this.sessionAuthenticatedBytes = increment(this.sessionAuthenticatedBytes, bytes);
    if (this.lastSessionAuthenticatedAtMs !== null) {
      noteTimingSample(
        this.authenticatedInterarrival,
        this.elapsed(this.lastSessionAuthenticatedAtMs, now),
      );
    }
    this.lastSessionAuthenticatedAtMs = now;
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

  /** Add one bounded RTT observation, usually from a completed clock probe. */
  public noteRoundTrip(milliseconds: number): void {
    noteTimingSample(this.roundTrip, milliseconds);
  }

  /** Count critical-event transmissions beyond their first send. */
  public noteCriticalRetransmit(count = 1): void {
    this.criticalRetransmits = increment(
      this.criticalRetransmits,
      requireCounter(count, "Critical retransmit count"),
    );
  }

  /** Count outbound GAP_REQUEST control frames. */
  public noteGapRequest(count = 1): void {
    this.criticalGapRequests = increment(
      this.criticalGapRequests,
      requireCounter(count, "Critical gap request count"),
    );
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
      receiveSession: {
        rawFrames: this.sessionRawFrames,
        rawBytes: this.sessionRawBytes,
        decodedFrames: this.sessionDecodedFrames,
        decodedBytes: this.sessionDecodedBytes,
        authenticatedFrames: this.sessionAuthenticatedFrames,
        authenticatedBytes: this.sessionAuthenticatedBytes,
      },
      send: {
        frames: this.sentFrames,
        bytes: this.sentBytes,
        snapshots: this.sentSnapshots,
        keepalives: this.sentKeepalives,
        critical: this.sentCritical,
        other: this.sentOther,
        bytesByKind: {
          snapshots: this.sentSnapshotBytes,
          keepalives: this.sentKeepaliveBytes,
          critical: this.sentCriticalBytes,
          other: this.sentOtherBytes,
        },
        failed: {
          frames: this.failedSendFrames,
          bytes: this.failedSendBytes,
        },
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
      rtt: timingSummary(this.roundTrip),
      authenticatedInterarrival: timingSummary(
        this.authenticatedInterarrival,
      ),
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
        retransmits: this.criticalRetransmits,
        gapRequests: this.criticalGapRequests,
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

  private adjustSentKind(
    kind: MessageKind,
    frameAmount: 1 | -1,
    byteAmount: number,
  ): void {
    if (kind === "SNAPSHOT") {
      this.sentSnapshots = adjust(this.sentSnapshots, frameAmount);
      this.sentSnapshotBytes = adjust(this.sentSnapshotBytes, byteAmount);
      this.sentSnapshotsSinceAuthenticated = adjust(
        this.sentSnapshotsSinceAuthenticated,
        frameAmount,
      );
    } else if (kind === "KEEPALIVE") {
      this.sentKeepalives = adjust(this.sentKeepalives, frameAmount);
      this.sentKeepaliveBytes = adjust(this.sentKeepaliveBytes, byteAmount);
      this.sentKeepalivesSinceAuthenticated = adjust(
        this.sentKeepalivesSinceAuthenticated,
        frameAmount,
      );
    } else if (isCriticalKind(kind)) {
      this.sentCritical = adjust(this.sentCritical, frameAmount);
      this.sentCriticalBytes = adjust(this.sentCriticalBytes, byteAmount);
      this.sentCriticalSinceAuthenticated = adjust(
        this.sentCriticalSinceAuthenticated,
        frameAmount,
      );
    } else {
      this.sentOther = adjust(this.sentOther, frameAmount);
      this.sentOtherBytes = adjust(this.sentOtherBytes, byteAmount);
      this.sentOtherSinceAuthenticated = adjust(
        this.sentOtherSinceAuthenticated,
        frameAmount,
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
