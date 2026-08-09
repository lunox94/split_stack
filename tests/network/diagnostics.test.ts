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

  it("round-trips cloned incident and clock-sync timeout context", () => {
    const clock = new ManualClock(7_000);
    const storage = new MemoryStorage();
    const diagnostics = new NetworkDiagnostics({ clock, storage });
    const context = { matchId: "match-7", localSeat: "a" as const };
    const clockSync = {
      purpose: "initial" as const,
      targetSamples: 5,
      acceptedSamples: 3,
      retryRounds: 2,
      pingsSent: 15,
      pongsReceived: 7,
      pongOutcomes: {
        accepted: 3,
        unknownSample: 1,
        staleEcho: 1,
        duplicate: 1,
        invalidTiming: 1,
      },
      elapsedMs: 10_250,
      deadlineMs: 10_000,
      lastPongAgeMs: 750,
    };

    diagnostics.begin({ kind: "clock-sync-timeout", clockSync }, context);
    context.matchId = "mutated";
    clockSync.pongOutcomes.accepted = 0;

    const expectedIncident = {
      incidentId: 1,
      startedAtMs: 7_000,
      context: { matchId: "match-7", localSeat: "a" },
      events: [{
        kind: "clock-sync-timeout",
        atMs: 7_000,
        clockSync: {
          purpose: "initial",
          targetSamples: 5,
          acceptedSamples: 3,
          retryRounds: 2,
          pingsSent: 15,
          pongsReceived: 7,
          pongOutcomes: {
            accepted: 3,
            unknownSample: 1,
            staleEcho: 1,
            duplicate: 1,
            invalidTiming: 1,
          },
          elapsedMs: 10_250,
          deadlineMs: 10_000,
          lastPongAgeMs: 750,
        },
      }],
    };
    expect(diagnostics.snapshot().incidents[0]).toEqual(expectedIncident);

    const copy = diagnostics.snapshot();
    copy.incidents[0]!.context!.matchId = "copy-mutated";
    copy.incidents[0]!.events[0]!.clockSync!.pongOutcomes.accepted = 0;
    expect(diagnostics.snapshot().incidents[0]).toEqual(expectedIncident);
    expect(new NetworkDiagnostics({ clock, storage }).snapshot().incidents[0])
      .toEqual(expectedIncident);
  });

  it("round-trips remote tick, pause trigger, and detach reason context", () => {
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(8_000) });
    const incidentId = diagnostics.begin({
      kind: "desynchronized",
      reason: "remote-tick-out-of-range",
      snapshotsAccepted: 10,
      snapshotsRejected: 0,
      remoteTick: {
        source: "network-pause",
        localTick: 100,
        remoteTargetTick: 112,
        maxAllowedDeltaTicks: 6,
      },
    });
    diagnostics.record(incidentId, {
      kind: "connection-unstable",
      pauseTrigger: "peer-network-pause",
      pauseEpoch: 2,
    });
    diagnostics.record(incidentId, {
      kind: "channel-detached",
      detachReason: "session-teardown",
    });

    expect(diagnostics.snapshot().incidents[0]?.events).toEqual([
      {
        kind: "desynchronized",
        atMs: 8_000,
        reason: "remote-tick-out-of-range",
        snapshotsAccepted: 10,
        snapshotsRejected: 0,
        remoteTick: {
          source: "network-pause",
          localTick: 100,
          remoteTargetTick: 112,
          maxAllowedDeltaTicks: 6,
        },
      },
      {
        kind: "connection-unstable",
        atMs: 8_000,
        pauseTrigger: "peer-network-pause",
        pauseEpoch: 2,
      },
      {
        kind: "channel-detached",
        atMs: 8_000,
        detachReason: "session-teardown",
      },
    ]);
  });

  it("round-trips enough rollback context to distinguish pause adoption from resume reconciliation", () => {
    const clock = new ManualClock(8_500);
    const storage = new MemoryStorage();
    const diagnostics = new NetworkDiagnostics({ clock, storage });
    const incidentId = diagnostics.begin({
      kind: "connection-unstable",
      pauseTick: 13_147,
    });
    diagnostics.record(incidentId, {
      kind: "resume-countdown",
      pauseTick: 13_090,
      rollbackTicks: 0,
      rollback: {
        originalPauseTick: 13_147,
        localResumeTick: 13_090,
        remoteResumeTick: 13_090,
        finalCommonTick: 13_090,
      },
    });

    const restored = new NetworkDiagnostics({ clock, storage }).snapshot();
    expect(restored.incidents[0]?.events[1]).toEqual({
      kind: "resume-countdown",
      atMs: 8_500,
      pauseTick: 13_090,
      rollbackTicks: 0,
      rollback: {
        originalPauseTick: 13_147,
        localResumeTick: 13_090,
        remoteResumeTick: 13_090,
        finalCommonTick: 13_090,
      },
    });

    const copy = diagnostics.snapshot();
    copy.incidents[0]!.events[1]!.rollback!.originalPauseTick = 0;
    expect(
      diagnostics.snapshot().incidents[0]?.events[1]?.rollback?.originalPauseTick,
    ).toBe(13_147);
  });

  it("round-trips rollback context when an ahead peer advances the local pause tick", () => {
    const clock = new ManualClock(8_550);
    const storage = new MemoryStorage();
    const diagnostics = new NetworkDiagnostics({ clock, storage });

    diagnostics.begin({
      kind: "resume-countdown",
      pauseTick: 96,
      rollbackTicks: 0,
      rollback: {
        originalPauseTick: 90,
        localResumeTick: 96,
        remoteResumeTick: 96,
        finalCommonTick: 96,
      },
    });

    const produced = diagnostics.snapshot();
    expect(produced.incidents[0]?.events[0]?.rollback).toEqual({
      originalPauseTick: 90,
      localResumeTick: 96,
      remoteResumeTick: 96,
      finalCommonTick: 96,
    });
    expect(parseNetworkDiagnostics(JSON.stringify(produced))).toEqual(produced);
    expect(new NetworkDiagnostics({ clock, storage }).snapshot()).toEqual(
      produced,
    );
  });

  it("omits malformed persisted rollback context and rejects malformed producer context", () => {
    const persisted = {
      schema: "split-stack/network-diagnostics/v1",
      incidents: [{
        incidentId: 1,
        startedAtMs: 8_600,
        events: [{
          kind: "resume-countdown",
          atMs: 8_600,
          rollback: {
            originalPauseTick: 100,
            localResumeTick: 90,
            remoteResumeTick: 95,
            finalCommonTick: 95,
          },
        }],
      }],
    };
    expect(parseNetworkDiagnostics(JSON.stringify(persisted))).toEqual({
      schema: "split-stack/network-diagnostics/v1",
      incidents: [{
        incidentId: 1,
        startedAtMs: 8_600,
        events: [{ kind: "resume-countdown", atMs: 8_600 }],
      }],
    });

    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(8_600) });
    expect(() => diagnostics.begin({
      kind: "resume-countdown",
      rollback: {
        originalPauseTick: 100,
        localResumeTick: 90,
        remoteResumeTick: 95,
        finalCommonTick: 95,
      },
    })).toThrow(TypeError);
    expect(() => diagnostics.begin({
      kind: "connection-unstable",
      rollback: {
        originalPauseTick: 100,
        localResumeTick: 90,
        remoteResumeTick: 90,
        finalCommonTick: 90,
      },
    })).toThrow(TypeError);
  });

  it("omits malformed optional v1 extensions while preserving base records", () => {
    const parsed = parseNetworkDiagnostics(JSON.stringify({
      schema: "split-stack/network-diagnostics/v1",
      incidents: [{
        incidentId: 1,
        startedAtMs: 9_000,
        context: { matchId: "contains\nnewline", localSeat: "a" },
        events: [{
          kind: "desynchronized",
          atMs: 9_000,
          reason: "remote-tick-out-of-range",
          snapshotsAccepted: 4,
          snapshotsRejected: 0,
          remoteTick: {
            source: "top-out",
            localTick: 100,
            remoteTargetTick: 105,
            maxAllowedDeltaTicks: 6,
          },
          pauseTrigger: "not-a-trigger",
          detachReason: "not-a-reason",
        }],
      }],
    }));

    expect(parsed.incidents).toEqual([{
      incidentId: 1,
      startedAtMs: 9_000,
      events: [{
        kind: "desynchronized",
        atMs: 9_000,
        reason: "remote-tick-out-of-range",
        snapshotsAccepted: 4,
        snapshotsRejected: 0,
      }],
    }]);
  });

  it("drops a clock-sync timeout event whose required summary is inconsistent", () => {
    const parsed = parseNetworkDiagnostics(JSON.stringify({
      schema: "split-stack/network-diagnostics/v1",
      incidents: [{
        incidentId: 1,
        startedAtMs: 10_000,
        events: [
          {
            kind: "clock-sync-timeout",
            atMs: 10_000,
            clockSync: {
              purpose: "resume",
              targetSamples: 5,
              acceptedSamples: 6,
              retryRounds: 1,
              pingsSent: 10,
              pongsReceived: 6,
              pongOutcomes: {
                accepted: 6,
                unknownSample: 0,
                staleEcho: 0,
                duplicate: 0,
                invalidTiming: 0,
              },
              elapsedMs: 10_000,
              deadlineMs: 10_000,
            },
          },
          { kind: "channel-detached", atMs: 10_001 },
        ],
      }],
    }));

    expect(parsed.incidents[0]?.events).toEqual([
      { kind: "channel-detached", atMs: 10_001 },
    ]);
  });

  it("rejects malformed producer context and extensions without consuming an ID", () => {
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(11_000) });
    const validClockSync = {
      purpose: "resume" as const,
      targetSamples: 5,
      acceptedSamples: 4,
      retryRounds: 1,
      pingsSent: 10,
      pongsReceived: 4,
      pongOutcomes: {
        accepted: 4,
        unknownSample: 0,
        staleEcho: 0,
        duplicate: 0,
        invalidTiming: 0,
      },
      elapsedMs: 10_000,
      deadlineMs: 10_000,
    };

    expect(() => diagnostics.begin(
      { kind: "clock-sync-timeout", clockSync: validClockSync },
      { matchId: "", localSeat: "a" },
    )).toThrow(TypeError);
    expect(() => diagnostics.begin({
      kind: "clock-sync-timeout",
      clockSync: {
        ...validClockSync,
        pongsReceived: 3,
      },
    })).toThrow(TypeError);
    expect(() => diagnostics.begin({
      kind: "desynchronized",
      reason: "remote-tick-out-of-range",
      snapshotsAccepted: 0,
      snapshotsRejected: 0,
      remoteTick: {
        source: "top-out",
        localTick: 100,
        remoteTargetTick: 106,
        maxAllowedDeltaTicks: 6,
      },
    })).toThrow(TypeError);
    expect(() => diagnostics.begin({
      kind: "channel-detached",
      pauseTrigger: "visibility",
      detachReason: "invalid" as "unknown",
    })).toThrow(TypeError);
    expect(() => diagnostics.begin({
      kind: "desynchronized",
      reason: "remote-tick-out-of-range",
      snapshotsAccepted: 0,
      snapshotsRejected: 0,
      pauseTrigger: "visibility",
    })).toThrow(TypeError);
    expect(() => diagnostics.begin({
      kind: "connection-unstable",
      detachReason: "unknown",
    })).toThrow(TypeError);

    expect(diagnostics.snapshot().incidents).toEqual([]);
    expect(diagnostics.begin({ kind: "channel-detached" })).toBe(1);
  });

  it("continues parsing original v1 JSON without extension fields", () => {
    const original = {
      schema: "split-stack/network-diagnostics/v1",
      incidents: [{
        incidentId: 4,
        startedAtMs: 12_000,
        events: [{
          kind: "connection-unstable",
          atMs: 12_010,
          silenceMs: 531,
          pauseTick: 0,
        }],
      }],
    };

    expect(parseNetworkDiagnostics(JSON.stringify(original))).toEqual(original);
  });
});
