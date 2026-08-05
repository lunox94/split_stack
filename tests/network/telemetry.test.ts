import { describe, expect, it } from "vitest";

import { ManualClock } from "../../src/network/in-memory";
import { NetworkTelemetry } from "../../src/network/telemetry";

describe("NetworkTelemetry", () => {
  it("summarizes receive stages and only the traffic after the last authenticated peer frame", () => {
    const clock = new ManualClock(1_000);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.noteChannelAttached();
    telemetry.notePump();
    clock.advance(25);
    telemetry.noteRawReceived(200);
    telemetry.noteDecodedReceived(200);
    telemetry.noteAuthenticatedReceived(200);
    clock.advance(5);
    telemetry.noteSent(1_600, "SNAPSHOT");
    telemetry.noteSent(120, "KEEPALIVE");
    telemetry.noteSent(80, "GARBAGE_ATTACK");
    telemetry.noteSent(50, "ACK");
    telemetry.noteRawReceived(50);
    telemetry.notePump();
    clock.advance(45);
    telemetry.notePump();

    expect(telemetry.snapshot()).toEqual({
      channel: {
        generation: 1,
        attached: true,
        ageMs: 75,
        firstRawFrameMs: 25,
        firstAuthenticatedFrameMs: 25,
      },
      receive: {
        rawFrames: 2,
        rawBytes: 250,
        decodedFrames: 1,
        decodedBytes: 200,
        authenticatedFrames: 1,
        authenticatedBytes: 200,
        rawAgeMs: 45,
        decodedAgeMs: 50,
        authenticatedAgeMs: 50,
      },
      sinceAuthenticated: {
        sentFrames: 4,
        sentBytes: 1_850,
        receivedFrames: 1,
        receivedBytes: 50,
        sentSnapshots: 1,
        sentKeepalives: 1,
        sentCritical: 1,
        sentOther: 1,
      },
      pump: {
        lastGapMs: 45,
        maxGapMs: 45,
      },
      snapshots: {
        accepted: 0,
        gapEvents: 0,
        missing: 0,
        maxGap: 0,
      },
      critical: {
        pending: 0,
        maxPending: 0,
      },
    });
  });

  it("counts accepted snapshot gaps and the observed critical-outbox high-water mark", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(2_000) });

    telemetry.noteSnapshotAccepted(10);
    telemetry.noteSnapshotAccepted(11);
    telemetry.noteSnapshotAccepted(14);
    telemetry.noteSnapshotAccepted(20);
    telemetry.noteCriticalPending(2);
    telemetry.noteCriticalPending(1);
    telemetry.noteCriticalPending(4);
    telemetry.noteCriticalPending(0);

    expect(telemetry.snapshot()).toMatchObject({
      snapshots: {
        accepted: 4,
        gapEvents: 2,
        missing: 7,
        maxGap: 5,
        lastSeq: 20,
      },
      critical: {
        pending: 0,
        maxPending: 4,
      },
    });
  });

  it("starts a fresh fixed-cardinality receive profile for each channel generation", () => {
    const clock = new ManualClock(3_000);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.noteChannelAttached();
    clock.advance(10);
    telemetry.noteRawReceived(100);
    telemetry.noteDecodedReceived(100);
    telemetry.noteAuthenticatedReceived(100);
    clock.advance(10);
    telemetry.noteChannelDetached();
    clock.advance(10);
    telemetry.noteChannelAttached();
    clock.advance(7);
    telemetry.noteRawReceived(40);

    expect(telemetry.snapshot()).toMatchObject({
      channel: {
        generation: 2,
        attached: true,
        ageMs: 7,
        firstRawFrameMs: 7,
      },
      receive: {
        rawFrames: 1,
        rawBytes: 40,
        decodedFrames: 0,
        decodedBytes: 0,
        authenticatedFrames: 0,
        authenticatedBytes: 0,
        rawAgeMs: 0,
      },
      sinceAuthenticated: {
        receivedFrames: 1,
        receivedBytes: 40,
      },
    });
    expect(
      telemetry.snapshot().channel.firstAuthenticatedFrameMs,
    ).toBeUndefined();
    expect(
      telemetry.snapshot().receive.authenticatedAgeMs,
    ).toBeUndefined();
  });

  it("stages sends before reentrant traffic and rolls rejected sends back", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(4_000) });

    telemetry.noteSent(120, "KEEPALIVE");
    telemetry.noteAuthenticatedReceived(80);
    expect(telemetry.snapshot().sinceAuthenticated.sentFrames).toBe(0);

    telemetry.noteSent(1_600, "SNAPSHOT");
    telemetry.noteSendFailed(1_600, "SNAPSHOT");

    expect(telemetry.snapshot().sinceAuthenticated).toEqual({
      sentFrames: 0,
      sentBytes: 0,
      receivedFrames: 0,
      receivedBytes: 0,
      sentSnapshots: 0,
      sentKeepalives: 0,
      sentCritical: 0,
      sentOther: 0,
    });
  });
});
