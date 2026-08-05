import { describe, expect, it } from "vitest";

import {
  NETWORK_DIAGNOSTIC_EVENT_LIMIT,
  NETWORK_DIAGNOSTIC_INCIDENT_LIMIT,
  NetworkDiagnostics,
  parseNetworkDiagnostics,
} from "../../src/network/diagnostics";
import { ManualClock } from "../../src/network/in-memory";
import { NetworkTelemetry } from "../../src/network/telemetry";

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

  it("round-trips one compact telemetry summary without exposing mutable diagnostic state", () => {
    const clock = new ManualClock(4_000);
    const storage = new MemoryStorage();
    const telemetry = new NetworkTelemetry({ clock });
    telemetry.noteChannelAttached();
    clock.advance(20);
    telemetry.noteRawReceived(80);
    telemetry.noteDecodedReceived(80);
    telemetry.noteAuthenticatedReceived(80);
    clock.advance(3_000);
    telemetry.noteSent(160, "KEEPALIVE");
    const summary = telemetry.snapshot();
    const diagnostics = new NetworkDiagnostics({ clock, storage });

    diagnostics.begin({
      kind: "connection-unstable",
      silenceMs: 3_000,
      pauseTick: 300,
      telemetry: summary,
    });

    const copy = diagnostics.snapshot();
    expect(copy.incidents[0]?.events[0]?.telemetry).toEqual(summary);
    copy.incidents[0]!.events[0]!.telemetry!.channel.generation = 99;
    expect(
      diagnostics
        .snapshot()
        .incidents[0]?.events[0]?.telemetry?.channel.generation,
    ).toBe(1);
    expect(
      new NetworkDiagnostics({ clock, storage })
        .snapshot()
        .incidents[0]?.events[0]?.telemetry,
    ).toEqual(summary);
  });

  it("keeps a valid incident event while discarding an inconsistent optional telemetry summary", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(5_000) })
      .snapshot();
    telemetry.sinceAuthenticated.sentFrames = 1;

    const parsed = parseNetworkDiagnostics(JSON.stringify({
      schema: "split-stack/network-diagnostics/v1",
      incidents: [{
        incidentId: 1,
        startedAtMs: 5_000,
        events: [{
          kind: "connection-unstable",
          atMs: 5_000,
          silenceMs: 3_000,
          telemetry,
        }],
      }],
    }));

    expect(parsed.incidents[0]?.events[0]).toEqual({
      kind: "connection-unstable",
      atMs: 5_000,
      silenceMs: 3_000,
    });
  });

  it("does not consume an incident or ID when telemetry validation rejects its first event", () => {
    const diagnostics = new NetworkDiagnostics({
      clock: new ManualClock(6_000),
    });
    const telemetry = new NetworkTelemetry().snapshot();
    telemetry.sinceAuthenticated.sentFrames = 1;

    expect(() => diagnostics.begin({
      kind: "connection-unstable",
      telemetry,
    })).toThrow(TypeError);
    expect(diagnostics.snapshot().incidents).toEqual([]);
    expect(diagnostics.begin({ kind: "connection-unstable" })).toBe(1);
  });
});
