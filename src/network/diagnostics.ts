import type { MonotonicClock } from "./clock";
import {
  cloneNetworkTelemetrySummary,
  parseNetworkTelemetrySummary,
  type NetworkTelemetrySummary,
} from "./telemetry";

export const NETWORK_DIAGNOSTIC_INCIDENT_LIMIT = 3;
export const NETWORK_DIAGNOSTIC_EVENT_LIMIT = 100;
export const NETWORK_DIAGNOSTICS_STORAGE_KEY = "split-stack.network-diagnostics.v1";

export const DESYNCHRONIZATION_REASONS = [
  "result-consensus-timeout",
  "clock-sync-timeout",
  "clock-commit-timeout",
  "gameplay-journal-overflow",
  "future-gameplay-critical-applied",
  "top-out-state-hash-mismatch",
  "remote-start-out-of-range",
  "config-ack-timeout",
  "remote-tick-out-of-range",
  "remote-tick-checkpoint-missing",
  "resume-state-tick-mismatch",
] as const;

export type DesynchronizationReason =
  (typeof DESYNCHRONIZATION_REASONS)[number];

export const SNAPSHOT_REJECTION_REASONS = [
  "unbound-player",
  "session-mismatch",
  "invalid-payload",
  "player-mismatch",
  "tick-mismatch",
  "stale-sequence",
] as const;

export type SnapshotRejectionReason =
  (typeof SNAPSHOT_REJECTION_REASONS)[number];

export const CLOCK_SYNC_PURPOSES = ["initial", "resume"] as const;
export type ClockSyncPurpose = (typeof CLOCK_SYNC_PURPOSES)[number];

export interface ClockSyncPongOutcomes {
  accepted: number;
  unknownSample: number;
  staleEcho: number;
  duplicate: number;
  invalidTiming: number;
}

export interface ClockSyncTimeoutSummary {
  purpose: ClockSyncPurpose;
  targetSamples: number;
  acceptedSamples: number;
  retryRounds: number;
  pingsSent: number;
  pongsReceived: number;
  pongOutcomes: ClockSyncPongOutcomes;
  elapsedMs: number;
  deadlineMs: number;
  lastPongAgeMs?: number;
}

export const REMOTE_TICK_SOURCES = [
  "top-out",
  "network-pause",
  "resume-start-commit",
  "resume-common-tick",
] as const;
export type RemoteTickSource = (typeof REMOTE_TICK_SOURCES)[number];

export interface RemoteTickDiagnosticContext {
  source: RemoteTickSource;
  localTick: number;
  remoteTargetTick: number;
  maxAllowedDeltaTicks: number;
}

export const PAUSE_TRIGGERS = [
  "local-silence",
  "local-delivery-failure",
  "peer-network-pause",
  "visibility",
] as const;
export type PauseTrigger = (typeof PAUSE_TRIGGERS)[number];

export const DETACH_REASONS = [
  "replacement",
  "session-teardown",
  "startup-failure",
  "unknown",
] as const;
export type DetachReason = (typeof DETACH_REASONS)[number];

export interface NetworkDiagnosticIncidentContext {
  matchId: string;
  localSeat: "a" | "b";
}

export type NetworkDiagnosticEventKind =
  | "connection-unstable"
  | "channel-replacement-requested"
  | "channel-replacement-failed"
  | "channel-detached"
  | "channel-attached"
  | "peer-traffic-restored"
  | "resume-state-sent"
  | "resume-countdown"
  | "resumed"
  | "connection-lost"
  | "clock-sync-timeout"
  | "desynchronized";

export interface NetworkDiagnosticEventInput {
  kind: NetworkDiagnosticEventKind;
  silenceMs?: number;
  pauseTick?: number;
  pauseEpoch?: number;
  rollbackTicks?: number;
  attempt?: number;
  reason?: DesynchronizationReason;
  snapshotsAccepted?: number;
  snapshotsRejected?: number;
  lastSnapshotSeq?: number;
  lastSnapshotTick?: number;
  lastSnapshotAgeMs?: number;
  peerLastSnapshotSeq?: number;
  lastSnapshotRejection?: SnapshotRejectionReason;
  clockSync?: ClockSyncTimeoutSummary;
  remoteTick?: RemoteTickDiagnosticContext;
  pauseTrigger?: PauseTrigger;
  detachReason?: DetachReason;
  telemetry?: NetworkTelemetrySummary;
}

export interface NetworkDiagnosticEvent extends NetworkDiagnosticEventInput {
  atMs: number;
}

export interface NetworkDiagnosticIncident {
  incidentId: number;
  startedAtMs: number;
  context?: NetworkDiagnosticIncidentContext;
  events: NetworkDiagnosticEvent[];
}

export interface NetworkDiagnosticsSnapshot {
  schema: "split-stack/network-diagnostics/v1";
  incidents: NetworkDiagnosticIncident[];
}

export interface NetworkDiagnosticsOptions {
  clock?: MonotonicClock;
  storage?: NetworkDiagnosticsStorage;
  storageKey?: string;
}

export interface NetworkDiagnosticsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const systemClock: MonotonicClock = { now: () => Date.now() };
const EVENT_KINDS = new Set<NetworkDiagnosticEventKind>([
  "connection-unstable",
  "channel-replacement-requested",
  "channel-replacement-failed",
  "channel-detached",
  "channel-attached",
  "peer-traffic-restored",
  "resume-state-sent",
  "resume-countdown",
  "resumed",
  "connection-lost",
  "clock-sync-timeout",
  "desynchronized",
]);
const DESYNCHRONIZATION_REASON_SET = new Set<DesynchronizationReason>(
  DESYNCHRONIZATION_REASONS,
);
const SNAPSHOT_REJECTION_REASON_SET = new Set<SnapshotRejectionReason>(
  SNAPSHOT_REJECTION_REASONS,
);
const CLOCK_SYNC_PURPOSE_SET = new Set<ClockSyncPurpose>(CLOCK_SYNC_PURPOSES);
const REMOTE_TICK_SOURCE_SET = new Set<RemoteTickSource>(REMOTE_TICK_SOURCES);
const PAUSE_TRIGGER_SET = new Set<PauseTrigger>(PAUSE_TRIGGERS);
const DETACH_REASON_SET = new Set<DetachReason>(DETACH_REASONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function readIncidentContext(
  value: unknown,
): NetworkDiagnosticIncidentContext | undefined {
  if (!isRecord(value)) return undefined;
  const matchId = value.matchId;
  const localSeat = value.localSeat;
  if (
    typeof matchId !== "string" ||
    matchId.length < 1 ||
    matchId.length > 128 ||
    !/^[\x20-\x7e]+$/.test(matchId) ||
    (localSeat !== "a" && localSeat !== "b")
  ) {
    return undefined;
  }
  return { matchId, localSeat };
}

function readClockSyncTimeoutSummary(
  value: unknown,
): ClockSyncTimeoutSummary | undefined {
  if (!isRecord(value) || !isRecord(value.pongOutcomes)) return undefined;
  const purpose = CLOCK_SYNC_PURPOSE_SET.has(value.purpose as ClockSyncPurpose)
    ? value.purpose as ClockSyncPurpose
    : undefined;
  const targetSamples = readNonNegativeInteger(value.targetSamples);
  const acceptedSamples = readNonNegativeInteger(value.acceptedSamples);
  const retryRounds = readNonNegativeInteger(value.retryRounds);
  const pingsSent = readNonNegativeInteger(value.pingsSent);
  const pongsReceived = readNonNegativeInteger(value.pongsReceived);
  const accepted = readNonNegativeInteger(value.pongOutcomes.accepted);
  const unknownSample = readNonNegativeInteger(value.pongOutcomes.unknownSample);
  const staleEcho = readNonNegativeInteger(value.pongOutcomes.staleEcho);
  const duplicate = readNonNegativeInteger(value.pongOutcomes.duplicate);
  const invalidTiming = readNonNegativeInteger(value.pongOutcomes.invalidTiming);
  const elapsedMs = readNonNegativeInteger(value.elapsedMs);
  const deadlineMs = readNonNegativeInteger(value.deadlineMs);
  const lastPongAgeMs = value.lastPongAgeMs === undefined
    ? undefined
    : readNonNegativeInteger(value.lastPongAgeMs);
  if (
    purpose === undefined ||
    targetSamples === undefined ||
    targetSamples < 1 ||
    targetSamples > 32 ||
    acceptedSamples === undefined ||
    retryRounds === undefined ||
    pingsSent === undefined ||
    pongsReceived === undefined ||
    accepted === undefined ||
    unknownSample === undefined ||
    staleEcho === undefined ||
    duplicate === undefined ||
    invalidTiming === undefined ||
    elapsedMs === undefined ||
    deadlineMs === undefined ||
    (value.lastPongAgeMs !== undefined && lastPongAgeMs === undefined)
  ) {
    return undefined;
  }
  const outcomeTotal = accepted + unknownSample + staleEcho + duplicate + invalidTiming;
  if (
    !Number.isSafeInteger(outcomeTotal) ||
    acceptedSamples !== accepted ||
    acceptedSamples > targetSamples ||
    pongsReceived !== outcomeTotal ||
    elapsedMs < deadlineMs ||
    (lastPongAgeMs !== undefined && lastPongAgeMs > elapsedMs)
  ) {
    return undefined;
  }
  return {
    purpose,
    targetSamples,
    acceptedSamples,
    retryRounds,
    pingsSent,
    pongsReceived,
    pongOutcomes: {
      accepted,
      unknownSample,
      staleEcho,
      duplicate,
      invalidTiming,
    },
    elapsedMs,
    deadlineMs,
    ...(lastPongAgeMs === undefined ? {} : { lastPongAgeMs }),
  };
}

function readRemoteTickContext(
  value: unknown,
): RemoteTickDiagnosticContext | undefined {
  if (!isRecord(value)) return undefined;
  const source = REMOTE_TICK_SOURCE_SET.has(value.source as RemoteTickSource)
    ? value.source as RemoteTickSource
    : undefined;
  const localTick = readNonNegativeInteger(value.localTick);
  const remoteTargetTick = readNonNegativeInteger(value.remoteTargetTick);
  const maxAllowedDeltaTicks = readNonNegativeInteger(value.maxAllowedDeltaTicks);
  if (
    source === undefined ||
    localTick === undefined ||
    remoteTargetTick === undefined ||
    maxAllowedDeltaTicks === undefined ||
    maxAllowedDeltaTicks < 1 ||
    Math.abs(localTick - remoteTargetTick) <= maxAllowedDeltaTicks
  ) {
    return undefined;
  }
  return { source, localTick, remoteTargetTick, maxAllowedDeltaTicks };
}

function readEvent(value: unknown): NetworkDiagnosticEvent | undefined {
  if (!isRecord(value) || !EVENT_KINDS.has(value.kind as NetworkDiagnosticEventKind)) {
    return undefined;
  }
  const kind = value.kind as NetworkDiagnosticEventKind;
  const atMs = readNonNegativeInteger(value.atMs);
  if (atMs === undefined) return undefined;
  const silenceMs = readNonNegativeInteger(value.silenceMs);
  const pauseTick = readNonNegativeInteger(value.pauseTick);
  const pauseEpoch = readNonNegativeInteger(value.pauseEpoch);
  const rollbackTicks = readNonNegativeInteger(value.rollbackTicks);
  const attempt = readNonNegativeInteger(value.attempt);
  const reason = DESYNCHRONIZATION_REASON_SET.has(value.reason as DesynchronizationReason)
    ? value.reason as DesynchronizationReason
    : undefined;
  if (kind === "desynchronized" && reason === undefined) return undefined;
  const snapshotsAccepted = readNonNegativeInteger(value.snapshotsAccepted);
  const snapshotsRejected = readNonNegativeInteger(value.snapshotsRejected);
  const lastSnapshotSeq = readNonNegativeInteger(value.lastSnapshotSeq);
  const lastSnapshotTick = readNonNegativeInteger(value.lastSnapshotTick);
  const lastSnapshotAgeMs = readNonNegativeInteger(value.lastSnapshotAgeMs);
  const peerLastSnapshotSeq = readNonNegativeInteger(value.peerLastSnapshotSeq);
  const lastSnapshotRejection = SNAPSHOT_REJECTION_REASON_SET.has(
    value.lastSnapshotRejection as SnapshotRejectionReason,
  )
    ? value.lastSnapshotRejection as SnapshotRejectionReason
    : undefined;
  const telemetry = value.telemetry === undefined
    ? undefined
    : parseNetworkTelemetrySummary(value.telemetry);
  const clockSync = kind === "clock-sync-timeout"
    ? readClockSyncTimeoutSummary(value.clockSync)
    : undefined;
  if (kind === "clock-sync-timeout" && clockSync === undefined) return undefined;
  const remoteTick = kind === "desynchronized"
    ? readRemoteTickContext(value.remoteTick)
    : undefined;
  const pauseTrigger = kind === "connection-unstable" &&
    PAUSE_TRIGGER_SET.has(value.pauseTrigger as PauseTrigger)
    ? value.pauseTrigger as PauseTrigger
    : undefined;
  const detachReason = kind === "channel-detached" &&
    DETACH_REASON_SET.has(value.detachReason as DetachReason)
    ? value.detachReason as DetachReason
    : undefined;
  if (
    kind === "desynchronized" &&
    (
      snapshotsAccepted === undefined ||
      snapshotsRejected === undefined ||
      ![0, 3].includes(
        [lastSnapshotSeq, lastSnapshotTick, lastSnapshotAgeMs].filter(
          (field) => field !== undefined,
        ).length,
      ) ||
      (value.lastSnapshotRejection !== undefined &&
        lastSnapshotRejection === undefined)
    )
  ) {
    return undefined;
  }
  return {
    kind,
    atMs,
    ...(silenceMs === undefined ? {} : { silenceMs }),
    ...(pauseTick === undefined ? {} : { pauseTick }),
    ...(pauseEpoch === undefined ? {} : { pauseEpoch }),
    ...(rollbackTicks === undefined ? {} : { rollbackTicks }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(reason === undefined ? {} : { reason }),
    ...(snapshotsAccepted === undefined ? {} : { snapshotsAccepted }),
    ...(snapshotsRejected === undefined ? {} : { snapshotsRejected }),
    ...(lastSnapshotSeq === undefined ? {} : { lastSnapshotSeq }),
    ...(lastSnapshotTick === undefined ? {} : { lastSnapshotTick }),
    ...(lastSnapshotAgeMs === undefined ? {} : { lastSnapshotAgeMs }),
    ...(peerLastSnapshotSeq === undefined ? {} : { peerLastSnapshotSeq }),
    ...(lastSnapshotRejection === undefined ? {} : { lastSnapshotRejection }),
    ...(clockSync === undefined ? {} : { clockSync }),
    ...(remoteTick === undefined ? {} : { remoteTick }),
    ...(pauseTrigger === undefined ? {} : { pauseTrigger }),
    ...(detachReason === undefined ? {} : { detachReason }),
    ...(telemetry === undefined ? {} : { telemetry }),
  };
}

function enforceDiagnosticBounds(incidents: NetworkDiagnosticIncident[]): void {
  while (incidents.length > NETWORK_DIAGNOSTIC_INCIDENT_LIMIT) incidents.shift();
  let excess = incidents.reduce(
    (total, incident) => total + incident.events.length,
    0,
  ) - NETWORK_DIAGNOSTIC_EVENT_LIMIT;
  while (excess > 0 && incidents.length > 0) {
    const oldest = incidents[0];
    if (oldest === undefined) break;
    const removable = Math.min(excess, oldest.events.length);
    oldest.events.splice(0, removable);
    excess -= removable;
    if (oldest.events.length === 0 && incidents.length > 1) incidents.shift();
  }
}

export function parseNetworkDiagnostics(serialized: string | null): NetworkDiagnosticsSnapshot {
  const empty: NetworkDiagnosticsSnapshot = {
    schema: "split-stack/network-diagnostics/v1",
    incidents: [],
  };
  if (serialized === null) return empty;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return empty;
  }
  if (
    !isRecord(value) ||
    value.schema !== "split-stack/network-diagnostics/v1" ||
    !Array.isArray(value.incidents)
  ) {
    return empty;
  }
  const incidents: NetworkDiagnosticIncident[] = [];
  for (const candidate of value.incidents.slice(-NETWORK_DIAGNOSTIC_INCIDENT_LIMIT)) {
    if (!isRecord(candidate) || !Array.isArray(candidate.events)) continue;
    const incidentId = readNonNegativeInteger(candidate.incidentId);
    const startedAtMs = readNonNegativeInteger(candidate.startedAtMs);
    if (incidentId === undefined || incidentId < 1 || startedAtMs === undefined) continue;
    const events = candidate.events
      .slice(-NETWORK_DIAGNOSTIC_EVENT_LIMIT)
      .map(readEvent)
      .filter((event): event is NetworkDiagnosticEvent => event !== undefined);
    if (events.length === 0) continue;
    const context = readIncidentContext(candidate.context);
    incidents.push({
      incidentId,
      startedAtMs,
      ...(context === undefined ? {} : { context }),
      events,
    });
  }
  enforceDiagnosticBounds(incidents);
  return { ...empty, incidents };
}

export function serializeNetworkDiagnostics(
  snapshot: NetworkDiagnosticsSnapshot,
  pretty = false,
): string {
  return JSON.stringify(snapshot, null, pretty ? 2 : undefined);
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Network diagnostic counters must be non-negative integers");
  }
  return value;
}

function cloneEvent(event: NetworkDiagnosticEvent): NetworkDiagnosticEvent {
  return {
    ...event,
    ...(event.clockSync === undefined
      ? {}
      : {
          clockSync: {
            ...event.clockSync,
            pongOutcomes: { ...event.clockSync.pongOutcomes },
          },
        }),
    ...(event.remoteTick === undefined
      ? {}
      : { remoteTick: { ...event.remoteTick } }),
    ...(event.telemetry === undefined
      ? {}
      : { telemetry: cloneNetworkTelemetrySummary(event.telemetry) }),
  };
}

function cloneIncident(incident: NetworkDiagnosticIncident): NetworkDiagnosticIncident {
  return {
    incidentId: incident.incidentId,
    startedAtMs: incident.startedAtMs,
    ...(incident.context === undefined
      ? {}
      : { context: { ...incident.context } }),
    events: incident.events.map(cloneEvent),
  };
}

/**
 * A deliberately narrow connection log. Its public record API has no fields for
 * player identity, user input, message bodies, or transport payloads.
 */
export class NetworkDiagnostics {
  private readonly clock: MonotonicClock;
  private readonly storage: NetworkDiagnosticsStorage | undefined;
  private readonly storageKey: string;
  private readonly incidents: NetworkDiagnosticIncident[] = [];
  private nextIncidentId = 1;

  public constructor(options: NetworkDiagnosticsOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.storage = options.storage;
    this.storageKey = options.storageKey ?? NETWORK_DIAGNOSTICS_STORAGE_KEY;
    let restored: NetworkDiagnosticsSnapshot;
    try {
      restored = parseNetworkDiagnostics(this.storage?.getItem(this.storageKey) ?? null);
    } catch {
      restored = parseNetworkDiagnostics(null);
    }
    this.incidents.push(...restored.incidents.map(cloneIncident));
    this.nextIncidentId =
      Math.max(0, ...this.incidents.map((incident) => incident.incidentId)) + 1;
  }

  public begin(
    event: NetworkDiagnosticEventInput,
    context?: NetworkDiagnosticIncidentContext,
  ): number {
    const incidentId = this.nextIncidentId;
    const startedAtMs = this.now();
    const validatedContext = context === undefined
      ? undefined
      : readIncidentContext(context);
    if (context !== undefined && validatedContext === undefined) {
      throw new TypeError("Invalid network diagnostic incident context");
    }
    const incident: NetworkDiagnosticIncident = {
      incidentId,
      startedAtMs,
      ...(validatedContext === undefined ? {} : { context: validatedContext }),
      events: [],
    };
    this.append(incident, event, startedAtMs);
    this.nextIncidentId += 1;
    this.incidents.push(incident);
    enforceDiagnosticBounds(this.incidents);
    this.persist();
    return incidentId;
  }

  public record(incidentId: number, event: NetworkDiagnosticEventInput): boolean {
    const incident = this.incidents.find((candidate) => candidate.incidentId === incidentId);
    if (incident === undefined) return false;
    this.append(incident, event, this.now());
    enforceDiagnosticBounds(this.incidents);
    this.persist();
    return true;
  }

  public snapshot(): NetworkDiagnosticsSnapshot {
    return {
      schema: "split-stack/network-diagnostics/v1",
      incidents: this.incidents.map(cloneIncident),
    };
  }

  public copyText(): string {
    return serializeNetworkDiagnostics(this.snapshot(), true);
  }

  public clear(): void {
    this.incidents.length = 0;
    try {
      if (this.storage?.removeItem !== undefined) {
        this.storage.removeItem(this.storageKey);
      } else {
        this.storage?.setItem(
          this.storageKey,
          serializeNetworkDiagnostics(this.snapshot()),
        );
      }
    } catch {
      // Diagnostics must never interrupt gameplay when storage is unavailable.
    }
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("Network diagnostic timestamps must be non-negative");
    }
    return Math.floor(now);
  }

  private append(
    incident: NetworkDiagnosticIncident,
    input: NetworkDiagnosticEventInput,
    atMs: number,
  ): void {
    if (!EVENT_KINDS.has(input.kind)) {
      throw new TypeError("Invalid network diagnostic event kind");
    }
    const silenceMs = nonNegativeInteger(input.silenceMs);
    const pauseTick = nonNegativeInteger(input.pauseTick);
    const pauseEpoch = nonNegativeInteger(input.pauseEpoch);
    const rollbackTicks = nonNegativeInteger(input.rollbackTicks);
    const attempt = nonNegativeInteger(input.attempt);
    const snapshotsAccepted = nonNegativeInteger(input.snapshotsAccepted);
    const snapshotsRejected = nonNegativeInteger(input.snapshotsRejected);
    const lastSnapshotSeq = nonNegativeInteger(input.lastSnapshotSeq);
    const lastSnapshotTick = nonNegativeInteger(input.lastSnapshotTick);
    const lastSnapshotAgeMs = nonNegativeInteger(input.lastSnapshotAgeMs);
    const peerLastSnapshotSeq = nonNegativeInteger(input.peerLastSnapshotSeq);
    const telemetry = input.telemetry === undefined
      ? undefined
      : parseNetworkTelemetrySummary(input.telemetry);
    if (input.telemetry !== undefined && telemetry === undefined) {
      throw new TypeError("Invalid network telemetry summary");
    }
    const clockSync = input.clockSync === undefined
      ? undefined
      : readClockSyncTimeoutSummary(input.clockSync);
    if (
      (input.kind === "clock-sync-timeout" && clockSync === undefined) ||
      (input.kind !== "clock-sync-timeout" && input.clockSync !== undefined)
    ) {
      throw new TypeError("Invalid clock synchronization timeout summary");
    }
    const remoteTick = input.remoteTick === undefined
      ? undefined
      : readRemoteTickContext(input.remoteTick);
    if (
      (input.remoteTick !== undefined && remoteTick === undefined) ||
      (input.kind !== "desynchronized" && input.remoteTick !== undefined)
    ) {
      throw new TypeError("Invalid remote tick diagnostic context");
    }
    if (
      input.pauseTrigger !== undefined &&
      (
        input.kind !== "connection-unstable" ||
        !PAUSE_TRIGGER_SET.has(input.pauseTrigger)
      )
    ) {
      throw new TypeError("Invalid network pause trigger");
    }
    if (
      input.detachReason !== undefined &&
      (
        input.kind !== "channel-detached" ||
        !DETACH_REASON_SET.has(input.detachReason)
      )
    ) {
      throw new TypeError("Invalid channel detach reason");
    }
    if (
      input.kind === "desynchronized" &&
      (
        !DESYNCHRONIZATION_REASON_SET.has(input.reason as DesynchronizationReason) ||
        snapshotsAccepted === undefined ||
        snapshotsRejected === undefined ||
        ![0, 3].includes(
          [lastSnapshotSeq, lastSnapshotTick, lastSnapshotAgeMs].filter(
            (field) => field !== undefined,
          ).length,
        ) ||
        (input.lastSnapshotRejection !== undefined &&
          !SNAPSHOT_REJECTION_REASON_SET.has(input.lastSnapshotRejection))
      )
    ) {
      throw new TypeError("Invalid desynchronization diagnostic event");
    }
    incident.events.push({
      kind: input.kind,
      atMs,
      ...(silenceMs === undefined ? {} : { silenceMs }),
      ...(pauseTick === undefined ? {} : { pauseTick }),
      ...(pauseEpoch === undefined ? {} : { pauseEpoch }),
      ...(rollbackTicks === undefined ? {} : { rollbackTicks }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(snapshotsAccepted === undefined ? {} : { snapshotsAccepted }),
      ...(snapshotsRejected === undefined ? {} : { snapshotsRejected }),
      ...(lastSnapshotSeq === undefined ? {} : { lastSnapshotSeq }),
      ...(lastSnapshotTick === undefined ? {} : { lastSnapshotTick }),
      ...(lastSnapshotAgeMs === undefined ? {} : { lastSnapshotAgeMs }),
      ...(peerLastSnapshotSeq === undefined ? {} : { peerLastSnapshotSeq }),
      ...(input.lastSnapshotRejection === undefined
        ? {}
        : { lastSnapshotRejection: input.lastSnapshotRejection }),
      ...(clockSync === undefined ? {} : { clockSync }),
      ...(remoteTick === undefined ? {} : { remoteTick }),
      ...(input.pauseTrigger === undefined
        ? {}
        : { pauseTrigger: input.pauseTrigger }),
      ...(input.detachReason === undefined
        ? {}
        : { detachReason: input.detachReason }),
      ...(telemetry === undefined ? {} : { telemetry }),
    });
    while (incident.events.length > NETWORK_DIAGNOSTIC_EVENT_LIMIT) {
      incident.events.shift();
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(
        this.storageKey,
        serializeNetworkDiagnostics(this.snapshot()),
      );
    } catch {
      // Quota and privacy-mode failures are best-effort for diagnostics.
    }
  }
}
