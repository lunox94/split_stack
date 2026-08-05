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
  | "desynchronized";

export interface NetworkDiagnosticEventInput {
  kind: NetworkDiagnosticEventKind;
  silenceMs?: number;
  pauseTick?: number;
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
  telemetry?: NetworkTelemetrySummary;
}

export interface NetworkDiagnosticEvent extends NetworkDiagnosticEventInput {
  atMs: number;
}

export interface NetworkDiagnosticIncident {
  incidentId: number;
  startedAtMs: number;
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
  "desynchronized",
]);
const DESYNCHRONIZATION_REASON_SET = new Set<DesynchronizationReason>(
  DESYNCHRONIZATION_REASONS,
);
const SNAPSHOT_REJECTION_REASON_SET = new Set<SnapshotRejectionReason>(
  SNAPSHOT_REJECTION_REASONS,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function readEvent(value: unknown): NetworkDiagnosticEvent | undefined {
  if (!isRecord(value) || !EVENT_KINDS.has(value.kind as NetworkDiagnosticEventKind)) {
    return undefined;
  }
  const atMs = readNonNegativeInteger(value.atMs);
  if (atMs === undefined) return undefined;
  const silenceMs = readNonNegativeInteger(value.silenceMs);
  const pauseTick = readNonNegativeInteger(value.pauseTick);
  const rollbackTicks = readNonNegativeInteger(value.rollbackTicks);
  const attempt = readNonNegativeInteger(value.attempt);
  const reason = DESYNCHRONIZATION_REASON_SET.has(value.reason as DesynchronizationReason)
    ? value.reason as DesynchronizationReason
    : undefined;
  if (value.kind === "desynchronized" && reason === undefined) return undefined;
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
  if (
    value.kind === "desynchronized" &&
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
    kind: value.kind as NetworkDiagnosticEventKind,
    atMs,
    ...(silenceMs === undefined ? {} : { silenceMs }),
    ...(pauseTick === undefined ? {} : { pauseTick }),
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
    incidents.push({ incidentId, startedAtMs, events });
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
    ...(event.telemetry === undefined
      ? {}
      : { telemetry: cloneNetworkTelemetrySummary(event.telemetry) }),
  };
}

function cloneIncident(incident: NetworkDiagnosticIncident): NetworkDiagnosticIncident {
  return {
    incidentId: incident.incidentId,
    startedAtMs: incident.startedAtMs,
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

  public begin(event: NetworkDiagnosticEventInput): number {
    const incidentId = this.nextIncidentId;
    const startedAtMs = this.now();
    const incident: NetworkDiagnosticIncident = {
      incidentId,
      startedAtMs,
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
    const silenceMs = nonNegativeInteger(input.silenceMs);
    const pauseTick = nonNegativeInteger(input.pauseTick);
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
