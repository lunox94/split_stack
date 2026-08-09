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
  byKind?: NetworkReceiveKindTotals;
}

export interface NetworkReceiveKindTotals {
  snapshots: number;
  keepalives: number;
  clockPings: number;
  clockPongs: number;
  acks: number;
  critical: number;
  other: number;
}

export interface NetworkSendTotals {
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
}

export interface NetworkTrafficWindow {
  sentFrames: number;
  sentBytes: number;
  receivedFrames: number;
  receivedBytes: number;
  sentSnapshots: number;
  sentKeepalives: number;
  sentCritical: number;
  sentOther: number;
  windowAgeMs?: number;
}

export const OUTBOUND_DELIVERY_PROOF_SOURCES = [
  "delivery-probe-echo",
  "critical-ack",
  "critical-cursor",
  "snapshot-cursor",
  "clock-pong",
] as const;

export type OutboundDeliveryProofSource =
  (typeof OUTBOUND_DELIVERY_PROOF_SOURCES)[number];

export interface OutboundDeliveryCursorProofSummary {
  lastAgeMs: number;
  lastCursor?: number;
}

export interface OutboundDeliverySampleProofSummary {
  lastAgeMs: number;
  lastSampleId?: number;
}

export interface OutboundDeliveryProofMetadataMap {
  "delivery-probe-echo": { cursor?: number };
  "critical-ack": { cursor?: number };
  "critical-cursor": { cursor?: number };
  "snapshot-cursor": { cursor?: number };
  "clock-pong": { sampleId?: number };
}

export interface OutboundDeliveryProofSummary {
  total: number;
  ageMs?: number;
  bySource: {
    deliveryProbeEcho: number;
    criticalAck: number;
    criticalCursor: number;
    snapshotCursor: number;
    clockPong: number;
  };
  deliveryProbe: {
    sent: number;
    echoed: number;
    lastSentSeq?: number;
    lastSentAgeMs?: number;
    lastEchoedSeq?: number;
    lastEchoedAgeMs?: number;
  };
  criticalAck?: OutboundDeliveryCursorProofSummary;
  criticalCursor?: OutboundDeliveryCursorProofSummary;
  snapshotCursor?: OutboundDeliveryCursorProofSummary;
  clockPong?: OutboundDeliverySampleProofSummary;
}

export interface NetworkTelemetrySummary {
  channel: {
    generation: number;
    attached: boolean;
    ageMs?: number;
    firstRawFrameMs?: number;
    firstAuthenticatedFrameMs?: number;
    currentGenerationInbound?: boolean;
    currentGenerationOutboundProof?: boolean;
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
    byKind?: NetworkReceiveKindTotals;
  };
  /** Session-wide receive totals; unlike `receive`, these survive channel replacement. */
  receiveSession?: NetworkReceiveTotals;
  send?: NetworkSendTotals;
  /** Successful and rejected writes on only the currently attached channel. */
  sendChannel?: NetworkSendTotals;
  sinceAuthenticated: NetworkTrafficWindow;
  /** Traffic since the most recent end-to-end proof, or monitoring start. */
  sinceOutboundProof?: NetworkTrafficWindow;
  outboundProof?: OutboundDeliveryProofSummary;
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
    /** `null` means periodic snapshots are deliberately suspended. */
    activeIntervalTicks?: number | null;
    deliveryLag?: number;
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

/** Identifies the exact counter windows staged before a transport send. */
export interface NetworkSendAttempt {
  readonly channelGeneration: number;
  readonly authenticatedWindowGeneration: number;
  readonly outboundProofWindowGeneration: number;
}

/** Identifies one delivery probe staged across a synchronous transport send. */
export interface NetworkDeliveryProbeAttempt {
  readonly generation: number;
  readonly previousLastSequence: number | null;
  readonly previousLastAtMs: number | null;
  readonly incremented: boolean;
}

interface SentCounterScopes {
  readonly lifetime: boolean;
  readonly channel: boolean;
  readonly authenticatedWindow: boolean;
  readonly outboundProofWindow: boolean;
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

function createReceiveKindTotals(): NetworkReceiveKindTotals {
  return {
    snapshots: 0,
    keepalives: 0,
    clockPings: 0,
    clockPongs: 0,
    acks: 0,
    critical: 0,
    other: 0,
  };
}

function resetReceiveKindTotals(totals: NetworkReceiveKindTotals): void {
  totals.snapshots = 0;
  totals.keepalives = 0;
  totals.clockPings = 0;
  totals.clockPongs = 0;
  totals.acks = 0;
  totals.critical = 0;
  totals.other = 0;
}

function readReceiveKindTotals(
  value: unknown,
): NetworkReceiveKindTotals | undefined {
  if (!isRecord(value)) return undefined;
  const snapshots = readCounter(value.snapshots);
  const keepalives = readCounter(value.keepalives);
  const clockPings = readCounter(value.clockPings);
  const clockPongs = readCounter(value.clockPongs);
  const acks = readCounter(value.acks);
  const critical = readCounter(value.critical);
  const other = readCounter(value.other);
  if (
    snapshots === undefined ||
    keepalives === undefined ||
    clockPings === undefined ||
    clockPongs === undefined ||
    acks === undefined ||
    critical === undefined ||
    other === undefined
  ) {
    return undefined;
  }
  return {
    snapshots,
    keepalives,
    clockPings,
    clockPongs,
    acks,
    critical,
    other,
  };
}

function receiveKindFrameTotal(totals: NetworkReceiveKindTotals): number {
  return totals.snapshots + totals.keepalives + totals.clockPings +
    totals.clockPongs + totals.acks + totals.critical + totals.other;
}

function receiveKindsFitWithin(
  subset: NetworkReceiveKindTotals,
  totals: NetworkReceiveKindTotals,
): boolean {
  return subset.snapshots <= totals.snapshots &&
    subset.keepalives <= totals.keepalives &&
    subset.clockPings <= totals.clockPings &&
    subset.clockPongs <= totals.clockPongs &&
    subset.acks <= totals.acks &&
    subset.critical <= totals.critical &&
    subset.other <= totals.other;
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

function readSendTotals(value: unknown): NetworkSendTotals | undefined {
  if (!isRecord(value)) return undefined;
  const frames = readCounter(value.frames);
  const bytes = readCounter(value.bytes);
  const snapshots = readCounter(value.snapshots);
  const keepalives = readCounter(value.keepalives);
  const critical = readCounter(value.critical);
  const other = readCounter(value.other);
  const bytesByKind = value.bytesByKind;
  const failed = value.failed;
  const snapshotBytes = isRecord(bytesByKind)
    ? readCounter(bytesByKind.snapshots)
    : undefined;
  const keepaliveBytes = isRecord(bytesByKind)
    ? readCounter(bytesByKind.keepalives)
    : undefined;
  const criticalBytes = isRecord(bytesByKind)
    ? readCounter(bytesByKind.critical)
    : undefined;
  const otherBytes = isRecord(bytesByKind)
    ? readCounter(bytesByKind.other)
    : undefined;
  const failedFrames = isRecord(failed) ? readCounter(failed.frames) : undefined;
  const failedBytes = isRecord(failed) ? readCounter(failed.bytes) : undefined;
  if (
    frames === undefined ||
    bytes === undefined ||
    snapshots === undefined ||
    keepalives === undefined ||
    critical === undefined ||
    other === undefined ||
    snapshots + keepalives + critical + other !== frames ||
    (bytesByKind !== undefined &&
      (
        snapshotBytes === undefined ||
        keepaliveBytes === undefined ||
        criticalBytes === undefined ||
        otherBytes === undefined ||
        snapshotBytes + keepaliveBytes + criticalBytes + otherBytes !== bytes
      )) ||
    (failed !== undefined && (failedFrames === undefined || failedBytes === undefined))
  ) {
    return undefined;
  }
  return {
    frames,
    bytes,
    snapshots,
    keepalives,
    critical,
    other,
    ...(snapshotBytes === undefined
      ? {}
      : {
          bytesByKind: {
            snapshots: snapshotBytes,
            keepalives: keepaliveBytes!,
            critical: criticalBytes!,
            other: otherBytes!,
          },
        }),
    ...(failedFrames === undefined
      ? {}
      : { failed: { frames: failedFrames, bytes: failedBytes! } }),
  };
}

function readTrafficWindow(value: unknown): NetworkTrafficWindow | undefined {
  if (!isRecord(value)) return undefined;
  const sentFrames = readCounter(value.sentFrames);
  const sentBytes = readCounter(value.sentBytes);
  const receivedFrames = readCounter(value.receivedFrames);
  const receivedBytes = readCounter(value.receivedBytes);
  const sentSnapshots = readCounter(value.sentSnapshots);
  const sentKeepalives = readCounter(value.sentKeepalives);
  const sentCritical = readCounter(value.sentCritical);
  const sentOther = readCounter(value.sentOther);
  const windowAgeMs = optionalCounter(value, "windowAgeMs");
  if (
    sentFrames === undefined ||
    sentBytes === undefined ||
    receivedFrames === undefined ||
    receivedBytes === undefined ||
    sentSnapshots === undefined ||
    sentKeepalives === undefined ||
    sentCritical === undefined ||
    sentOther === undefined ||
    windowAgeMs === null ||
    sentSnapshots + sentKeepalives + sentCritical + sentOther !== sentFrames
  ) {
    return undefined;
  }
  return {
    sentFrames,
    sentBytes,
    receivedFrames,
    receivedBytes,
    sentSnapshots,
    sentKeepalives,
    sentCritical,
    sentOther,
    ...(windowAgeMs === undefined ? {} : { windowAgeMs }),
  };
}

function readOutboundCursorProofSummary(
  value: unknown,
): OutboundDeliveryCursorProofSummary | undefined {
  if (!isRecord(value)) return undefined;
  const lastAgeMs = readCounter(value.lastAgeMs);
  const lastCursor = optionalCounter(value, "lastCursor");
  if (lastAgeMs === undefined || lastCursor === null) return undefined;
  return {
    lastAgeMs,
    ...(lastCursor === undefined ? {} : { lastCursor }),
  };
}

function readOutboundSampleProofSummary(
  value: unknown,
): OutboundDeliverySampleProofSummary | undefined {
  if (!isRecord(value)) return undefined;
  const lastAgeMs = readCounter(value.lastAgeMs);
  const lastSampleId = optionalCounter(value, "lastSampleId");
  if (lastAgeMs === undefined || lastSampleId === null) return undefined;
  return {
    lastAgeMs,
    ...(lastSampleId === undefined ? {} : { lastSampleId }),
  };
}

function readOutboundProofSummary(
  value: unknown,
): OutboundDeliveryProofSummary | undefined {
  if (!isRecord(value) || !isRecord(value.bySource) || !isRecord(value.deliveryProbe)) {
    return undefined;
  }
  const total = readCounter(value.total);
  const ageMs = optionalCounter(value, "ageMs");
  const deliveryProbeEcho = readCounter(value.bySource.deliveryProbeEcho);
  const criticalAck = readCounter(value.bySource.criticalAck);
  const criticalCursor = readCounter(value.bySource.criticalCursor);
  const snapshotCursor = readCounter(value.bySource.snapshotCursor);
  const clockPong = readCounter(value.bySource.clockPong);
  const sent = readCounter(value.deliveryProbe.sent);
  const echoed = readCounter(value.deliveryProbe.echoed);
  const lastSentSeq = optionalCounter(value.deliveryProbe, "lastSentSeq");
  const lastSentAgeMs = optionalCounter(value.deliveryProbe, "lastSentAgeMs");
  const lastEchoedSeq = optionalCounter(value.deliveryProbe, "lastEchoedSeq");
  const lastEchoedAgeMs = optionalCounter(value.deliveryProbe, "lastEchoedAgeMs");
  const criticalAckDetail = value.criticalAck === undefined
    ? undefined
    : readOutboundCursorProofSummary(value.criticalAck);
  const criticalCursorDetail = value.criticalCursor === undefined
    ? undefined
    : readOutboundCursorProofSummary(value.criticalCursor);
  const snapshotCursorDetail = value.snapshotCursor === undefined
    ? undefined
    : readOutboundCursorProofSummary(value.snapshotCursor);
  const clockPongDetail = value.clockPong === undefined
    ? undefined
    : readOutboundSampleProofSummary(value.clockPong);
  if (
    total === undefined ||
    ageMs === null ||
    deliveryProbeEcho === undefined ||
    criticalAck === undefined ||
    criticalCursor === undefined ||
    snapshotCursor === undefined ||
    clockPong === undefined ||
    sent === undefined ||
    echoed === undefined ||
    lastSentSeq === null ||
    lastSentAgeMs === null ||
    lastEchoedSeq === null ||
    lastEchoedAgeMs === null ||
    (value.criticalAck !== undefined && criticalAckDetail === undefined) ||
    (value.criticalCursor !== undefined && criticalCursorDetail === undefined) ||
    (value.snapshotCursor !== undefined && snapshotCursorDetail === undefined) ||
    (value.clockPong !== undefined && clockPongDetail === undefined) ||
    (criticalAckDetail !== undefined && criticalAck === 0) ||
    (criticalCursorDetail !== undefined && criticalCursor === 0) ||
    (snapshotCursorDetail !== undefined && snapshotCursor === 0) ||
    (clockPongDetail !== undefined && clockPong === 0) ||
    deliveryProbeEcho + criticalAck + criticalCursor + snapshotCursor + clockPong !== total ||
    deliveryProbeEcho !== echoed ||
    echoed > sent ||
    (total === 0) !== (ageMs === undefined) ||
    (sent === 0) !== (lastSentSeq === undefined && lastSentAgeMs === undefined) ||
    (sent > 0) !== (lastSentSeq !== undefined && lastSentAgeMs !== undefined) ||
    (echoed === 0) !==
      (lastEchoedSeq === undefined && lastEchoedAgeMs === undefined) ||
    (echoed > 0) !==
      (lastEchoedSeq !== undefined && lastEchoedAgeMs !== undefined)
  ) {
    return undefined;
  }
  return {
    total,
    ...(ageMs === undefined ? {} : { ageMs }),
    bySource: {
      deliveryProbeEcho,
      criticalAck,
      criticalCursor,
      snapshotCursor,
      clockPong,
    },
    deliveryProbe: {
      sent,
      echoed,
      ...(lastSentSeq === undefined ? {} : { lastSentSeq }),
      ...(lastSentAgeMs === undefined ? {} : { lastSentAgeMs }),
      ...(lastEchoedSeq === undefined ? {} : { lastEchoedSeq }),
      ...(lastEchoedAgeMs === undefined ? {} : { lastEchoedAgeMs }),
    },
    ...(criticalAckDetail === undefined
      ? {}
      : { criticalAck: criticalAckDetail }),
    ...(criticalCursorDetail === undefined
      ? {}
      : { criticalCursor: criticalCursorDetail }),
    ...(snapshotCursorDetail === undefined
      ? {}
      : { snapshotCursor: snapshotCursorDetail }),
    ...(clockPongDetail === undefined
      ? {}
      : { clockPong: clockPongDetail }),
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
    sendChannel,
    sinceAuthenticated,
    sinceOutboundProof,
    outboundProof,
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
    (sendChannel !== undefined && !isRecord(sendChannel)) ||
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
  const currentGenerationInbound = channel.currentGenerationInbound;
  const currentGenerationOutboundProof =
    channel.currentGenerationOutboundProof;
  const rawFrames = readCounter(receive.rawFrames);
  const rawBytes = readCounter(receive.rawBytes);
  const decodedFrames = readCounter(receive.decodedFrames);
  const decodedBytes = readCounter(receive.decodedBytes);
  const authenticatedFrames = readCounter(receive.authenticatedFrames);
  const authenticatedBytes = readCounter(receive.authenticatedBytes);
  const rawAgeMs = optionalCounter(receive, "rawAgeMs");
  const decodedAgeMs = optionalCounter(receive, "decodedAgeMs");
  const authenticatedAgeMs = optionalCounter(receive, "authenticatedAgeMs");
  const authenticatedByKind = receive.byKind === undefined
    ? undefined
    : readReceiveKindTotals(receive.byKind);
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
  const sessionAuthenticatedByKind = receiveSession?.byKind === undefined
    ? undefined
    : readReceiveKindTotals(receiveSession.byKind);
  const sendSummary = send === undefined ? undefined : readSendTotals(send);
  const totalSentFrames = sendSummary?.frames;
  const totalSentBytes = sendSummary?.bytes;
  const totalSentSnapshots = sendSummary?.snapshots;
  const totalSentKeepalives = sendSummary?.keepalives;
  const totalSentCritical = sendSummary?.critical;
  const totalSentOther = sendSummary?.other;
  const sentSnapshotBytes = sendSummary?.bytesByKind?.snapshots;
  const sentKeepaliveBytes = sendSummary?.bytesByKind?.keepalives;
  const sentCriticalBytes = sendSummary?.bytesByKind?.critical;
  const sentOtherBytes = sendSummary?.bytesByKind?.other;
  const failedSendFrames = sendSummary?.failed?.frames;
  const failedSendBytes = sendSummary?.failed?.bytes;
  const channelSendSummary = sendChannel === undefined
    ? undefined
    : readSendTotals(sendChannel);
  const outboundProofWindow = sinceOutboundProof === undefined
    ? undefined
    : readTrafficWindow(sinceOutboundProof);
  const outboundProofSummary = outboundProof === undefined
    ? undefined
    : readOutboundProofSummary(outboundProof);
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
  const activeSnapshotIntervalTicks =
    snapshots.activeIntervalTicks === null
      ? null
      : optionalCounter(snapshots, "activeIntervalTicks");
  const invalidActiveSnapshotInterval =
    snapshots.activeIntervalTicks !== undefined &&
    snapshots.activeIntervalTicks !== null &&
    activeSnapshotIntervalTicks === null;
  const snapshotDeliveryLag = optionalCounter(snapshots, "deliveryLag");
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
    (currentGenerationInbound !== undefined &&
      typeof currentGenerationInbound !== "boolean") ||
    (currentGenerationOutboundProof !== undefined &&
      typeof currentGenerationOutboundProof !== "boolean") ||
    ((currentGenerationInbound === undefined) !==
      (currentGenerationOutboundProof === undefined)) ||
    rawFrames === undefined ||
    rawBytes === undefined ||
    decodedFrames === undefined ||
    decodedBytes === undefined ||
    authenticatedFrames === undefined ||
    authenticatedBytes === undefined ||
    rawAgeMs === null ||
    decodedAgeMs === null ||
    authenticatedAgeMs === null ||
    (receive.byKind !== undefined && authenticatedByKind === undefined) ||
    (receiveSession !== undefined &&
      (
        sessionRawFrames === undefined ||
        sessionRawBytes === undefined ||
        sessionDecodedFrames === undefined ||
        sessionDecodedBytes === undefined ||
        sessionAuthenticatedFrames === undefined ||
        sessionAuthenticatedBytes === undefined
      )) ||
    (receiveSession?.byKind !== undefined &&
      sessionAuthenticatedByKind === undefined) ||
    (send !== undefined && sendSummary === undefined) ||
    (sendChannel !== undefined && channelSendSummary === undefined) ||
    (sinceOutboundProof !== undefined && outboundProofWindow === undefined) ||
    (outboundProof !== undefined && outboundProofSummary === undefined) ||
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
    invalidActiveSnapshotInterval ||
    snapshotDeliveryLag === null ||
    ((activeSnapshotIntervalTicks === undefined) !==
      (snapshotDeliveryLag === undefined)) ||
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
    ((outboundProofWindow === undefined) !==
      (outboundProofSummary === undefined)) ||
    (outboundProofWindow?.windowAgeMs !== undefined &&
      outboundProofSummary?.ageMs !== undefined &&
      outboundProofWindow.windowAgeMs !== outboundProofSummary.ageMs) ||
    (currentGenerationInbound !== undefined &&
      currentGenerationInbound !== (authenticatedFrames > 0)) ||
    (currentGenerationOutboundProof === true &&
      (outboundProofSummary?.total ?? 0) === 0) ||
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
    (channelSendSummary !== undefined &&
      (
        totalSentFrames === undefined ||
        channelSendSummary.frames > totalSentFrames ||
        channelSendSummary.bytes > totalSentBytes! ||
        channelSendSummary.snapshots > totalSentSnapshots! ||
        channelSendSummary.keepalives > totalSentKeepalives! ||
        channelSendSummary.critical > totalSentCritical! ||
        channelSendSummary.other > totalSentOther! ||
        (channelSendSummary.bytesByKind !== undefined &&
          sendSummary?.bytesByKind !== undefined &&
          (
            channelSendSummary.bytesByKind.snapshots >
              sendSummary.bytesByKind.snapshots ||
            channelSendSummary.bytesByKind.keepalives >
              sendSummary.bytesByKind.keepalives ||
            channelSendSummary.bytesByKind.critical >
              sendSummary.bytesByKind.critical ||
            channelSendSummary.bytesByKind.other >
              sendSummary.bytesByKind.other
          )) ||
        (channelSendSummary.failed?.frames ?? 0) > (failedSendFrames ?? 0) ||
        (channelSendSummary.failed?.bytes ?? 0) > (failedSendBytes ?? 0)
      )) ||
    (outboundProofWindow !== undefined &&
      (
        totalSentFrames === undefined ||
        outboundProofWindow.sentFrames > totalSentFrames ||
        outboundProofWindow.sentBytes > totalSentBytes! ||
        outboundProofWindow.sentSnapshots > totalSentSnapshots! ||
        outboundProofWindow.sentKeepalives > totalSentKeepalives! ||
        outboundProofWindow.sentCritical > totalSentCritical! ||
        outboundProofWindow.sentOther > totalSentOther! ||
        (sessionRawFrames !== undefined &&
          outboundProofWindow.receivedFrames > sessionRawFrames) ||
        (sessionRawBytes !== undefined &&
          outboundProofWindow.receivedBytes > sessionRawBytes)
      )) ||
    (maxPumpGapSessionMs !== undefined &&
      maxPumpGapSessionMs < maxPumpGapMs) ||
    decodedFrames > rawFrames ||
    authenticatedFrames > decodedFrames ||
    decodedBytes > rawBytes ||
    authenticatedBytes > decodedBytes ||
    (authenticatedByKind !== undefined &&
      receiveKindFrameTotal(authenticatedByKind) !== authenticatedFrames) ||
    (sessionRawFrames !== undefined &&
      (
        sessionRawFrames < rawFrames ||
        sessionRawBytes! < rawBytes ||
        receivedFrames > sessionRawFrames ||
        receivedBytes > sessionRawBytes! ||
        sessionDecodedFrames! < decodedFrames ||
        sessionDecodedBytes! < decodedBytes ||
        sessionAuthenticatedFrames! < authenticatedFrames ||
        sessionAuthenticatedBytes! < authenticatedBytes ||
        sessionDecodedFrames! > sessionRawFrames ||
        sessionAuthenticatedFrames! > sessionDecodedFrames! ||
        sessionDecodedBytes! > sessionRawBytes! ||
        sessionAuthenticatedBytes! > sessionDecodedBytes!
      )) ||
    (sessionAuthenticatedByKind !== undefined &&
      receiveKindFrameTotal(sessionAuthenticatedByKind) !==
        sessionAuthenticatedFrames) ||
    (authenticatedByKind !== undefined &&
      sessionAuthenticatedByKind !== undefined &&
      !receiveKindsFitWithin(
        authenticatedByKind,
        sessionAuthenticatedByKind,
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
      ...(currentGenerationInbound === undefined
        ? {}
        : { currentGenerationInbound }),
      ...(currentGenerationOutboundProof === undefined
        ? {}
        : { currentGenerationOutboundProof }),
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
      ...(authenticatedByKind === undefined
        ? {}
        : { byKind: authenticatedByKind }),
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
            ...(sessionAuthenticatedByKind === undefined
              ? {}
              : { byKind: sessionAuthenticatedByKind }),
          },
        }),
    ...(sendSummary === undefined ? {} : { send: sendSummary }),
    ...(channelSendSummary === undefined
      ? {}
      : { sendChannel: channelSendSummary }),
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
    ...(outboundProofWindow === undefined
      ? {}
      : { sinceOutboundProof: outboundProofWindow }),
    ...(outboundProofSummary === undefined
      ? {}
      : { outboundProof: outboundProofSummary }),
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
      ...(activeSnapshotIntervalTicks === undefined
        ? {}
        : { activeIntervalTicks: activeSnapshotIntervalTicks }),
      ...(snapshotDeliveryLag === undefined
        ? {}
        : { deliveryLag: snapshotDeliveryLag }),
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
    receive: {
      ...summary.receive,
      ...(summary.receive.byKind === undefined
        ? {}
        : { byKind: { ...summary.receive.byKind } }),
    },
    ...(summary.receiveSession === undefined
      ? {}
      : {
          receiveSession: {
            ...summary.receiveSession,
            ...(summary.receiveSession.byKind === undefined
              ? {}
              : { byKind: { ...summary.receiveSession.byKind } }),
          },
        }),
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
    ...(summary.sendChannel === undefined
      ? {}
      : {
          sendChannel: {
            ...summary.sendChannel,
            ...(summary.sendChannel.bytesByKind === undefined
              ? {}
              : { bytesByKind: { ...summary.sendChannel.bytesByKind } }),
            ...(summary.sendChannel.failed === undefined
              ? {}
              : { failed: { ...summary.sendChannel.failed } }),
          },
        }),
    sinceAuthenticated: { ...summary.sinceAuthenticated },
    ...(summary.sinceOutboundProof === undefined
      ? {}
      : { sinceOutboundProof: { ...summary.sinceOutboundProof } }),
    ...(summary.outboundProof === undefined
      ? {}
      : {
          outboundProof: {
            ...summary.outboundProof,
            bySource: { ...summary.outboundProof.bySource },
            deliveryProbe: { ...summary.outboundProof.deliveryProbe },
            ...(summary.outboundProof.criticalAck === undefined
              ? {}
              : { criticalAck: { ...summary.outboundProof.criticalAck } }),
            ...(summary.outboundProof.criticalCursor === undefined
              ? {}
              : {
                  criticalCursor: {
                    ...summary.outboundProof.criticalCursor,
                  },
                }),
            ...(summary.outboundProof.snapshotCursor === undefined
              ? {}
              : {
                  snapshotCursor: {
                    ...summary.outboundProof.snapshotCursor,
                  },
                }),
            ...(summary.outboundProof.clockPong === undefined
              ? {}
              : { clockPong: { ...summary.outboundProof.clockPong } }),
          },
        }),
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
  private readonly authenticatedByKind = createReceiveKindTotals();

  private sessionRawFrames = 0;
  private sessionRawBytes = 0;
  private sessionDecodedFrames = 0;
  private sessionDecodedBytes = 0;
  private sessionAuthenticatedFrames = 0;
  private sessionAuthenticatedBytes = 0;
  private lastSessionAuthenticatedAtMs: number | null = null;
  private readonly authenticatedInterarrival = createTimingAccumulator();
  private readonly sessionAuthenticatedByKind = createReceiveKindTotals();

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

  private channelSentFrames = 0;
  private channelSentBytes = 0;
  private channelSentSnapshots = 0;
  private channelSentKeepalives = 0;
  private channelSentCritical = 0;
  private channelSentOther = 0;
  private channelSentSnapshotBytes = 0;
  private channelSentKeepaliveBytes = 0;
  private channelSentCriticalBytes = 0;
  private channelSentOtherBytes = 0;
  private channelFailedSendFrames = 0;
  private channelFailedSendBytes = 0;

  private sentFramesSinceAuthenticated = 0;
  private sentBytesSinceAuthenticated = 0;
  private receivedFramesSinceAuthenticated = 0;
  private receivedBytesSinceAuthenticated = 0;
  private sentSnapshotsSinceAuthenticated = 0;
  private sentKeepalivesSinceAuthenticated = 0;
  private sentCriticalSinceAuthenticated = 0;
  private sentOtherSinceAuthenticated = 0;
  private sinceAuthenticatedWindowStartedAtMs: number | null = null;
  private authenticatedWindowGeneration = 0;

  private sentFramesSinceOutboundProof = 0;
  private sentBytesSinceOutboundProof = 0;
  private receivedFramesSinceOutboundProof = 0;
  private receivedBytesSinceOutboundProof = 0;
  private sentSnapshotsSinceOutboundProof = 0;
  private sentKeepalivesSinceOutboundProof = 0;
  private sentCriticalSinceOutboundProof = 0;
  private sentOtherSinceOutboundProof = 0;
  private sinceOutboundProofWindowStartedAtMs: number | null = null;
  private outboundProofWindowGeneration = 0;

  private currentGenerationOutboundProof = false;
  private lastOutboundProofAtMs: number | null = null;
  private outboundProofTotal = 0;
  private deliveryProbeEchoProofs = 0;
  private criticalAckProofs = 0;
  private criticalCursorProofs = 0;
  private snapshotCursorProofs = 0;
  private clockPongProofs = 0;
  private deliveryProbesSent = 0;
  private deliveryProbesEchoed = 0;
  private deliveryProbeAttemptGeneration = 0;
  private readonly rejectedDeliveryProbeAttempts =
    new WeakSet<NetworkDeliveryProbeAttempt>();
  private lastDeliveryProbeSentSeq: number | null = null;
  private lastDeliveryProbeSentAtMs: number | null = null;
  private lastDeliveryProbeEchoedSeq: number | null = null;
  private lastDeliveryProbeEchoedAtMs: number | null = null;
  private lastCriticalAckProofAtMs: number | null = null;
  private lastCriticalAckCursor: number | null = null;
  private lastCriticalCursorProofAtMs: number | null = null;
  private lastCriticalCursor: number | null = null;
  private lastSnapshotCursorProofAtMs: number | null = null;
  private lastSnapshotCursor: number | null = null;
  private lastClockPongProofAtMs: number | null = null;
  private lastClockPongSampleId: number | null = null;

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
  private activeSnapshotIntervalTicks: number | null | undefined = undefined;
  private snapshotDeliveryLag: number | null = null;

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
    resetReceiveKindTotals(this.authenticatedByKind);
    this.currentGenerationOutboundProof = false;
    this.channelSentFrames = 0;
    this.channelSentBytes = 0;
    this.channelSentSnapshots = 0;
    this.channelSentKeepalives = 0;
    this.channelSentCritical = 0;
    this.channelSentOther = 0;
    this.channelSentSnapshotBytes = 0;
    this.channelSentKeepaliveBytes = 0;
    this.channelSentCriticalBytes = 0;
    this.channelSentOtherBytes = 0;
    this.channelFailedSendFrames = 0;
    this.channelFailedSendBytes = 0;
    this.sinceOutboundProofWindowStartedAtMs ??= now;
  }

  public noteChannelDetached(): void {
    if (!this.channelAttached) return;
    this.channelAttached = false;
    this.channelDetachedAtMs = this.now();
  }

  /** Stage a frame before transport.send; pair a thrown send with noteSendFailed. */
  public noteSent(bytes: number, kind: MessageKind): NetworkSendAttempt {
    requireCounter(bytes, "Sent byte count");
    this.sentFrames = increment(this.sentFrames);
    this.sentBytes = increment(this.sentBytes, bytes);
    this.channelSentFrames = increment(this.channelSentFrames);
    this.channelSentBytes = increment(this.channelSentBytes, bytes);
    this.sentFramesSinceAuthenticated = increment(
      this.sentFramesSinceAuthenticated,
    );
    this.sentBytesSinceAuthenticated = increment(
      this.sentBytesSinceAuthenticated,
      bytes,
    );
    this.sentFramesSinceOutboundProof = increment(
      this.sentFramesSinceOutboundProof,
    );
    this.sentBytesSinceOutboundProof = increment(
      this.sentBytesSinceOutboundProof,
      bytes,
    );
    this.adjustSentKind(kind, 1, bytes);
    return {
      channelGeneration: this.channelGeneration,
      authenticatedWindowGeneration: this.authenticatedWindowGeneration,
      outboundProofWindowGeneration: this.outboundProofWindowGeneration,
    };
  }

  /** Roll back a staged send when the transport rejects it by throwing. */
  public noteSendFailed(
    bytes: number,
    kind: MessageKind,
    attempt?: NetworkSendAttempt,
  ): void {
    requireCounter(bytes, "Rejected send byte count");
    const sameChannel = attempt === undefined ||
      attempt.channelGeneration === this.channelGeneration;
    const sameAuthenticatedWindow = attempt === undefined ||
      attempt.authenticatedWindowGeneration ===
        this.authenticatedWindowGeneration;
    const sameOutboundProofWindow = attempt === undefined ||
      attempt.outboundProofWindowGeneration ===
        this.outboundProofWindowGeneration;
    this.failedSendFrames = increment(this.failedSendFrames);
    this.failedSendBytes = increment(this.failedSendBytes, bytes);
    if (sameChannel) {
      this.channelFailedSendFrames = increment(this.channelFailedSendFrames);
      this.channelFailedSendBytes = increment(this.channelFailedSendBytes, bytes);
    }
    this.sentFrames = decrement(this.sentFrames);
    this.sentBytes = decrement(this.sentBytes, bytes);
    if (sameChannel) {
      this.channelSentFrames = decrement(this.channelSentFrames);
      this.channelSentBytes = decrement(this.channelSentBytes, bytes);
    }
    if (sameAuthenticatedWindow) {
      this.sentFramesSinceAuthenticated = decrement(
        this.sentFramesSinceAuthenticated,
      );
      this.sentBytesSinceAuthenticated = decrement(
        this.sentBytesSinceAuthenticated,
        bytes,
      );
    }
    if (sameOutboundProofWindow) {
      this.sentFramesSinceOutboundProof = decrement(
        this.sentFramesSinceOutboundProof,
      );
      this.sentBytesSinceOutboundProof = decrement(
        this.sentBytesSinceOutboundProof,
        bytes,
      );
    }
    this.adjustSentKind(kind, -1, -bytes, {
      lifetime: true,
      channel: sameChannel,
      authenticatedWindow: sameAuthenticatedWindow,
      outboundProofWindow: sameOutboundProofWindow,
    });
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
    this.receivedFramesSinceOutboundProof = increment(
      this.receivedFramesSinceOutboundProof,
    );
    this.receivedBytesSinceOutboundProof = increment(
      this.receivedBytesSinceOutboundProof,
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
  public noteAuthenticatedReceived(bytes: number, kind?: MessageKind): void {
    requireCounter(bytes, "Authenticated byte count");
    const now = this.now();
    this.authenticatedFrames = increment(this.authenticatedFrames);
    this.authenticatedBytes = increment(this.authenticatedBytes, bytes);
    this.sessionAuthenticatedFrames = increment(this.sessionAuthenticatedFrames);
    this.sessionAuthenticatedBytes = increment(this.sessionAuthenticatedBytes, bytes);
    this.incrementAuthenticatedKind(this.authenticatedByKind, kind);
    this.incrementAuthenticatedKind(this.sessionAuthenticatedByKind, kind);
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

  /** Record the active periodic cadence and peer-acceptance lag without history. */
  public noteSnapshotFlow(
    intervalTicks: number | null,
    deliveryLag: number,
  ): void {
    this.activeSnapshotIntervalTicks = intervalTicks === null
      ? null
      : requireCounter(intervalTicks, "Active snapshot interval");
    this.snapshotDeliveryLag = requireCounter(
      deliveryLag,
      "Snapshot delivery lag",
    );
  }

  /** Stage one delivery probe before transport.send. */
  public noteDeliveryProbeSent(sequence: number): NetworkDeliveryProbeAttempt {
    const previousCount = this.deliveryProbesSent;
    const attempt: NetworkDeliveryProbeAttempt = {
      generation: increment(this.deliveryProbeAttemptGeneration),
      previousLastSequence: this.lastDeliveryProbeSentSeq,
      previousLastAtMs: this.lastDeliveryProbeSentAtMs,
      incremented: previousCount < Number.MAX_SAFE_INTEGER,
    };
    this.deliveryProbeAttemptGeneration = attempt.generation;
    this.lastDeliveryProbeSentSeq = requireCounter(
      sequence,
      "Delivery probe sequence",
    );
    this.lastDeliveryProbeSentAtMs = this.now();
    this.deliveryProbesSent = increment(this.deliveryProbesSent);
    return attempt;
  }

  /** Roll back a staged delivery probe when transport.send throws. */
  public noteDeliveryProbeSendFailed(
    attempt: NetworkDeliveryProbeAttempt,
  ): void {
    if (this.rejectedDeliveryProbeAttempts.has(attempt)) return;
    this.rejectedDeliveryProbeAttempts.add(attempt);
    if (attempt.incremented) {
      this.deliveryProbesSent = decrement(this.deliveryProbesSent);
    }
    if (attempt.generation !== this.deliveryProbeAttemptGeneration) return;
    this.lastDeliveryProbeSentSeq = attempt.previousLastSequence;
    this.lastDeliveryProbeSentAtMs = attempt.previousLastAtMs;
  }

  /** Record an echoed local probe and the corresponding outbound proof. */
  public noteDeliveryProbeEchoed(sequence: number): void {
    this.lastDeliveryProbeEchoedSeq = requireCounter(
      sequence,
      "Echoed delivery probe sequence",
    );
    this.lastDeliveryProbeEchoedAtMs = this.now();
    this.deliveryProbesEchoed = increment(this.deliveryProbesEchoed);
    this.noteOutboundDeliveryProof("delivery-probe-echo");
  }

  /** Record one bounded source category as end-to-end outbound delivery proof. */
  public noteOutboundDeliveryProof<S extends OutboundDeliveryProofSource>(
    source: S,
    metadata?: OutboundDeliveryProofMetadataMap[S],
    provesCurrentGeneration = true,
  ): void {
    const metadataRecord = metadata as
      | { cursor?: number; sampleId?: number }
      | undefined;
    const cursor = metadataRecord?.cursor === undefined
      ? null
      : requireCounter(metadataRecord.cursor, "Outbound proof cursor");
    const sampleId = metadataRecord?.sampleId === undefined
      ? null
      : requireCounter(metadataRecord.sampleId, "Clock sample ID");
    const now = this.now();
    switch (source) {
      case "delivery-probe-echo":
        this.deliveryProbeEchoProofs = increment(this.deliveryProbeEchoProofs);
        break;
      case "critical-ack":
        this.criticalAckProofs = increment(this.criticalAckProofs);
        this.lastCriticalAckProofAtMs = now;
        this.lastCriticalAckCursor = cursor;
        break;
      case "critical-cursor":
        this.criticalCursorProofs = increment(this.criticalCursorProofs);
        this.lastCriticalCursorProofAtMs = now;
        this.lastCriticalCursor = cursor;
        break;
      case "snapshot-cursor":
        this.snapshotCursorProofs = increment(this.snapshotCursorProofs);
        this.lastSnapshotCursorProofAtMs = now;
        this.lastSnapshotCursor = cursor;
        break;
      case "clock-pong":
        this.clockPongProofs = increment(this.clockPongProofs);
        this.lastClockPongProofAtMs = now;
        this.lastClockPongSampleId = sampleId;
        break;
      default: {
        const exhaustive: never = source;
        throw new TypeError(`Unknown outbound delivery proof source: ${exhaustive}`);
      }
    }
    this.outboundProofTotal = increment(this.outboundProofTotal);
    this.lastOutboundProofAtMs = now;
    if (provesCurrentGeneration) this.currentGenerationOutboundProof = true;
    this.resetOutboundProofWindow();
    this.sinceOutboundProofWindowStartedAtMs = now;
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
        currentGenerationInbound: this.authenticatedFrames > 0,
        currentGenerationOutboundProof: this.currentGenerationOutboundProof,
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
        byKind: { ...this.authenticatedByKind },
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
        byKind: { ...this.sessionAuthenticatedByKind },
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
      sendChannel: {
        frames: this.channelSentFrames,
        bytes: this.channelSentBytes,
        snapshots: this.channelSentSnapshots,
        keepalives: this.channelSentKeepalives,
        critical: this.channelSentCritical,
        other: this.channelSentOther,
        bytesByKind: {
          snapshots: this.channelSentSnapshotBytes,
          keepalives: this.channelSentKeepaliveBytes,
          critical: this.channelSentCriticalBytes,
          other: this.channelSentOtherBytes,
        },
        failed: {
          frames: this.channelFailedSendFrames,
          bytes: this.channelFailedSendBytes,
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
      sinceOutboundProof: {
        sentFrames: this.sentFramesSinceOutboundProof,
        sentBytes: this.sentBytesSinceOutboundProof,
        receivedFrames: this.receivedFramesSinceOutboundProof,
        receivedBytes: this.receivedBytesSinceOutboundProof,
        sentSnapshots: this.sentSnapshotsSinceOutboundProof,
        sentKeepalives: this.sentKeepalivesSinceOutboundProof,
        sentCritical: this.sentCriticalSinceOutboundProof,
        sentOther: this.sentOtherSinceOutboundProof,
        ...(this.sinceOutboundProofWindowStartedAtMs === null
          ? {}
          : {
              windowAgeMs: this.elapsed(
                this.sinceOutboundProofWindowStartedAtMs,
                now,
              ),
            }),
      },
      outboundProof: {
        total: this.outboundProofTotal,
        ...(this.lastOutboundProofAtMs === null
          ? {}
          : { ageMs: this.elapsed(this.lastOutboundProofAtMs, now) }),
        bySource: {
          deliveryProbeEcho: this.deliveryProbeEchoProofs,
          criticalAck: this.criticalAckProofs,
          criticalCursor: this.criticalCursorProofs,
          snapshotCursor: this.snapshotCursorProofs,
          clockPong: this.clockPongProofs,
        },
        deliveryProbe: {
          sent: this.deliveryProbesSent,
          echoed: this.deliveryProbesEchoed,
          ...(this.lastDeliveryProbeSentSeq === null
            ? {}
            : { lastSentSeq: this.lastDeliveryProbeSentSeq }),
          ...(this.lastDeliveryProbeSentAtMs === null
            ? {}
            : {
                lastSentAgeMs: this.elapsed(
                  this.lastDeliveryProbeSentAtMs,
                  now,
                ),
              }),
          ...(this.lastDeliveryProbeEchoedSeq === null
            ? {}
            : { lastEchoedSeq: this.lastDeliveryProbeEchoedSeq }),
          ...(this.lastDeliveryProbeEchoedAtMs === null
            ? {}
            : {
                lastEchoedAgeMs: this.elapsed(
                  this.lastDeliveryProbeEchoedAtMs,
                  now,
                ),
              }),
        },
        ...(this.lastCriticalAckProofAtMs === null
          ? {}
          : {
              criticalAck: {
                lastAgeMs: this.elapsed(this.lastCriticalAckProofAtMs, now),
                ...(this.lastCriticalAckCursor === null
                  ? {}
                  : { lastCursor: this.lastCriticalAckCursor }),
              },
            }),
        ...(this.lastCriticalCursorProofAtMs === null
          ? {}
          : {
              criticalCursor: {
                lastAgeMs: this.elapsed(
                  this.lastCriticalCursorProofAtMs,
                  now,
                ),
                ...(this.lastCriticalCursor === null
                  ? {}
                  : { lastCursor: this.lastCriticalCursor }),
              },
            }),
        ...(this.lastSnapshotCursorProofAtMs === null
          ? {}
          : {
              snapshotCursor: {
                lastAgeMs: this.elapsed(
                  this.lastSnapshotCursorProofAtMs,
                  now,
                ),
                ...(this.lastSnapshotCursor === null
                  ? {}
                  : { lastCursor: this.lastSnapshotCursor }),
              },
            }),
        ...(this.lastClockPongProofAtMs === null
          ? {}
          : {
              clockPong: {
                lastAgeMs: this.elapsed(this.lastClockPongProofAtMs, now),
                ...(this.lastClockPongSampleId === null
                  ? {}
                  : { lastSampleId: this.lastClockPongSampleId }),
              },
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
        ...(this.activeSnapshotIntervalTicks === undefined
          ? {}
          : { activeIntervalTicks: this.activeSnapshotIntervalTicks }),
        ...(this.snapshotDeliveryLag === null
          ? {}
          : { deliveryLag: this.snapshotDeliveryLag }),
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
    this.authenticatedWindowGeneration = increment(
      this.authenticatedWindowGeneration,
    );
    this.sentFramesSinceAuthenticated = 0;
    this.sentBytesSinceAuthenticated = 0;
    this.receivedFramesSinceAuthenticated = 0;
    this.receivedBytesSinceAuthenticated = 0;
    this.sentSnapshotsSinceAuthenticated = 0;
    this.sentKeepalivesSinceAuthenticated = 0;
    this.sentCriticalSinceAuthenticated = 0;
    this.sentOtherSinceAuthenticated = 0;
  }

  private resetOutboundProofWindow(): void {
    this.outboundProofWindowGeneration = increment(
      this.outboundProofWindowGeneration,
    );
    this.sentFramesSinceOutboundProof = 0;
    this.sentBytesSinceOutboundProof = 0;
    this.receivedFramesSinceOutboundProof = 0;
    this.receivedBytesSinceOutboundProof = 0;
    this.sentSnapshotsSinceOutboundProof = 0;
    this.sentKeepalivesSinceOutboundProof = 0;
    this.sentCriticalSinceOutboundProof = 0;
    this.sentOtherSinceOutboundProof = 0;
  }

  private adjustSentKind(
    kind: MessageKind,
    frameAmount: 1 | -1,
    byteAmount: number,
    scopes: SentCounterScopes = {
      lifetime: true,
      channel: true,
      authenticatedWindow: true,
      outboundProofWindow: true,
    },
  ): void {
    if (kind === "SNAPSHOT") {
      if (scopes.lifetime) {
        this.sentSnapshots = adjust(this.sentSnapshots, frameAmount);
        this.sentSnapshotBytes = adjust(this.sentSnapshotBytes, byteAmount);
      }
      if (scopes.channel) {
        this.channelSentSnapshots = adjust(
          this.channelSentSnapshots,
          frameAmount,
        );
        this.channelSentSnapshotBytes = adjust(
          this.channelSentSnapshotBytes,
          byteAmount,
        );
      }
      if (scopes.authenticatedWindow) {
        this.sentSnapshotsSinceAuthenticated = adjust(
          this.sentSnapshotsSinceAuthenticated,
          frameAmount,
        );
      }
      if (scopes.outboundProofWindow) {
        this.sentSnapshotsSinceOutboundProof = adjust(
          this.sentSnapshotsSinceOutboundProof,
          frameAmount,
        );
      }
    } else if (kind === "KEEPALIVE") {
      if (scopes.lifetime) {
        this.sentKeepalives = adjust(this.sentKeepalives, frameAmount);
        this.sentKeepaliveBytes = adjust(this.sentKeepaliveBytes, byteAmount);
      }
      if (scopes.channel) {
        this.channelSentKeepalives = adjust(
          this.channelSentKeepalives,
          frameAmount,
        );
        this.channelSentKeepaliveBytes = adjust(
          this.channelSentKeepaliveBytes,
          byteAmount,
        );
      }
      if (scopes.authenticatedWindow) {
        this.sentKeepalivesSinceAuthenticated = adjust(
          this.sentKeepalivesSinceAuthenticated,
          frameAmount,
        );
      }
      if (scopes.outboundProofWindow) {
        this.sentKeepalivesSinceOutboundProof = adjust(
          this.sentKeepalivesSinceOutboundProof,
          frameAmount,
        );
      }
    } else if (isCriticalKind(kind)) {
      if (scopes.lifetime) {
        this.sentCritical = adjust(this.sentCritical, frameAmount);
        this.sentCriticalBytes = adjust(this.sentCriticalBytes, byteAmount);
      }
      if (scopes.channel) {
        this.channelSentCritical = adjust(
          this.channelSentCritical,
          frameAmount,
        );
        this.channelSentCriticalBytes = adjust(
          this.channelSentCriticalBytes,
          byteAmount,
        );
      }
      if (scopes.authenticatedWindow) {
        this.sentCriticalSinceAuthenticated = adjust(
          this.sentCriticalSinceAuthenticated,
          frameAmount,
        );
      }
      if (scopes.outboundProofWindow) {
        this.sentCriticalSinceOutboundProof = adjust(
          this.sentCriticalSinceOutboundProof,
          frameAmount,
        );
      }
    } else {
      if (scopes.lifetime) {
        this.sentOther = adjust(this.sentOther, frameAmount);
        this.sentOtherBytes = adjust(this.sentOtherBytes, byteAmount);
      }
      if (scopes.channel) {
        this.channelSentOther = adjust(this.channelSentOther, frameAmount);
        this.channelSentOtherBytes = adjust(
          this.channelSentOtherBytes,
          byteAmount,
        );
      }
      if (scopes.authenticatedWindow) {
        this.sentOtherSinceAuthenticated = adjust(
          this.sentOtherSinceAuthenticated,
          frameAmount,
        );
      }
      if (scopes.outboundProofWindow) {
        this.sentOtherSinceOutboundProof = adjust(
          this.sentOtherSinceOutboundProof,
          frameAmount,
        );
      }
    }
  }

  private incrementAuthenticatedKind(
    totals: NetworkReceiveKindTotals,
    kind: MessageKind | undefined,
  ): void {
    if (kind === "SNAPSHOT") {
      totals.snapshots = increment(totals.snapshots);
    } else if (kind === "KEEPALIVE") {
      totals.keepalives = increment(totals.keepalives);
    } else if (kind === "CLOCK_PING") {
      totals.clockPings = increment(totals.clockPings);
    } else if (kind === "CLOCK_PONG") {
      totals.clockPongs = increment(totals.clockPongs);
    } else if (kind === "ACK") {
      totals.acks = increment(totals.acks);
    } else if (kind !== undefined && isCriticalKind(kind)) {
      totals.critical = increment(totals.critical);
    } else {
      totals.other = increment(totals.other);
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
