import type { MonotonicClock } from "./clock";

export const NETWORK_DIAGNOSTIC_INCIDENT_LIMIT = 3;
export const NETWORK_DIAGNOSTIC_EVENT_LIMIT = 100;
export const NETWORK_DIAGNOSTICS_STORAGE_KEY = "split-stack.network-diagnostics.v1";

export type NetworkDiagnosticEventKind =
  | "connection-unstable"
  | "channel-replacement-requested"
  | "channel-detached"
  | "channel-attached"
  | "peer-traffic-restored"
  | "resume-state-sent"
  | "resume-countdown"
  | "resumed"
  | "connection-lost";

export interface NetworkDiagnosticEventInput {
  kind: NetworkDiagnosticEventKind;
  silenceMs?: number;
  pauseTick?: number;
  rollbackTicks?: number;
  attempt?: number;
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
  "channel-detached",
  "channel-attached",
  "peer-traffic-restored",
  "resume-state-sent",
  "resume-countdown",
  "resumed",
  "connection-lost",
]);

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
  return {
    kind: value.kind as NetworkDiagnosticEventKind,
    atMs,
    ...(silenceMs === undefined ? {} : { silenceMs }),
    ...(pauseTick === undefined ? {} : { pauseTick }),
    ...(rollbackTicks === undefined ? {} : { rollbackTicks }),
    ...(attempt === undefined ? {} : { attempt }),
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
  return { ...event };
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
    this.nextIncidentId += 1;
    const startedAtMs = this.now();
    const incident: NetworkDiagnosticIncident = {
      incidentId,
      startedAtMs,
      events: [],
    };
    this.incidents.push(incident);
    this.append(incident, event, startedAtMs);
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
    incident.events.push({
      kind: input.kind,
      atMs,
      ...(silenceMs === undefined ? {} : { silenceMs }),
      ...(pauseTick === undefined ? {} : { pauseTick }),
      ...(rollbackTicks === undefined ? {} : { rollbackTicks }),
      ...(attempt === undefined ? {} : { attempt }),
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
