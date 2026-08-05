import { describe, expect, it } from "vitest";

import {
  NETWORK_DIAGNOSTIC_EVENT_LIMIT,
  NETWORK_DIAGNOSTIC_INCIDENT_LIMIT,
  NetworkDiagnostics,
  parseNetworkDiagnostics,
} from "../../src/network/diagnostics";
import { ManualClock } from "../../src/network/in-memory";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("NetworkDiagnostics", () => {
  it("retains the latest three incidents within one hundred total structured events", () => {
    const clock = new ManualClock(1_000);
    const diagnostics = new NetworkDiagnostics({ clock });

    for (let incident = 0; incident < NETWORK_DIAGNOSTIC_INCIDENT_LIMIT + 1; incident += 1) {
      const incidentId = diagnostics.begin({
        kind: "connection-unstable",
        silenceMs: 3_000,
        pauseTick: incident * 60,
      });
      for (let event = 0; event < 39; event += 1) {
        clock.advance(1);
        diagnostics.record(incidentId, {
          kind: "channel-replacement-requested",
          silenceMs: 5_000 + event,
          attempt: event + 1,
        });
      }
    }

    const snapshot = diagnostics.snapshot();
    expect(snapshot.incidents).toHaveLength(3);
    expect(snapshot.incidents[0]?.incidentId).toBe(2);
    expect(snapshot.incidents.flatMap((incident) => incident.events)).toHaveLength(
      NETWORK_DIAGNOSTIC_EVENT_LIMIT,
    );
    expect(snapshot.incidents[2]?.events[0]).toMatchObject({
      kind: "connection-unstable",
    });
    expect(snapshot.incidents[2]?.events[1]).toMatchObject({
      kind: "channel-replacement-requested",
      attempt: 1,
    });
    expect(snapshot.incidents[2]?.events[39]).toMatchObject({ attempt: 39 });
    expect(diagnostics.copyText()).toBe(JSON.stringify(snapshot, null, 2));
  });

  it("persists, safely rehydrates, and clears its copy-friendly snapshot", () => {
    const clock = new ManualClock(2_000);
    const storage = new MemoryStorage();
    const storageKey = "network-diagnostics-test";
    const first = new NetworkDiagnostics({ clock, storage, storageKey });
    const incidentId = first.begin({
      kind: "connection-unstable",
      silenceMs: 3_000,
      pauseTick: 240,
    });
    clock.advance(2_000);
    first.record(incidentId, {
      kind: "channel-replacement-requested",
      silenceMs: 5_000,
      attempt: 1,
    });
    first.record(incidentId, {
      kind: "channel-replacement-failed",
      silenceMs: 5_000,
      attempt: 1,
    });

    const restored = new NetworkDiagnostics({ clock, storage, storageKey });
    expect(restored.snapshot()).toEqual(first.snapshot());

    restored.clear();
    expect(restored.snapshot().incidents).toEqual([]);
    expect(storage.getItem(storageKey)).toBeNull();
  });

  it("round-trips bounded snapshot context with the exact desynchronization reason", () => {
    const clock = new ManualClock(3_000);
    const storage = new MemoryStorage();
    const diagnostics = new NetworkDiagnostics({ clock, storage });

    diagnostics.begin({
      kind: "desynchronized",
      reason: "top-out-state-hash-mismatch",
      snapshotsAccepted: 12,
      snapshotsRejected: 2,
      lastSnapshotSeq: 18,
      lastSnapshotTick: 108,
      lastSnapshotAgeMs: 250,
      peerLastSnapshotSeq: 22,
      lastSnapshotRejection: "session-mismatch",
    });

    expect(new NetworkDiagnostics({ clock, storage }).snapshot()).toEqual(
      diagnostics.snapshot(),
    );
  });

  it("drops malformed desynchronization diagnostics instead of guessing", () => {
    const malformed = JSON.stringify({
      schema: "split-stack/network-diagnostics/v1",
      incidents: [{
        incidentId: 1,
        startedAtMs: 1_000,
        events: [
          {
            kind: "desynchronized",
            atMs: 1_000,
            reason: "unknown-reason",
            snapshotsAccepted: 1,
            snapshotsRejected: 0,
          },
          {
            kind: "desynchronized",
            atMs: 1_001,
            reason: "clock-sync-timeout",
            snapshotsAccepted: -1,
            snapshotsRejected: 0,
          },
          {
            kind: "desynchronized",
            atMs: 1_002,
            reason: "clock-sync-timeout",
            snapshotsAccepted: 1,
            snapshotsRejected: 0,
            lastSnapshotSeq: 2,
          },
          {
            kind: "desynchronized",
            atMs: 1_003,
            reason: "clock-sync-timeout",
            snapshotsAccepted: 1,
            snapshotsRejected: 1,
            lastSnapshotRejection: "unknown-rejection",
          },
        ],
      }],
    });

    expect(parseNetworkDiagnostics(malformed).incidents).toEqual([]);
  });
});
