import { describe, expect, it } from "vitest";

import { ManualClock } from "../../src/network/in-memory";
import {
  cloneNetworkTelemetrySummary,
  NetworkTelemetry,
  parseNetworkTelemetrySummary,
} from "../../src/network/telemetry";

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
        currentGenerationInbound: true,
        currentGenerationOutboundProof: false,
      },
      receive: {
        rawFrames: 2,
        rawBytes: 250,
        decodedFrames: 1,
        decodedBytes: 200,
        authenticatedFrames: 1,
        authenticatedBytes: 200,
        byKind: {
          snapshots: 0,
          keepalives: 0,
          clockPings: 0,
          clockPongs: 0,
          acks: 0,
          critical: 0,
          other: 1,
        },
        rawAgeMs: 45,
        decodedAgeMs: 50,
        authenticatedAgeMs: 50,
      },
      receiveSession: {
        rawFrames: 2,
        rawBytes: 250,
        decodedFrames: 1,
        decodedBytes: 200,
        authenticatedFrames: 1,
        authenticatedBytes: 200,
        byKind: {
          snapshots: 0,
          keepalives: 0,
          clockPings: 0,
          clockPongs: 0,
          acks: 0,
          critical: 0,
          other: 1,
        },
      },
      send: {
        frames: 4,
        bytes: 1_850,
        snapshots: 1,
        keepalives: 1,
        critical: 1,
        other: 1,
        bytesByKind: {
          snapshots: 1_600,
          keepalives: 120,
          critical: 80,
          other: 50,
        },
        failed: {
          frames: 0,
          bytes: 0,
        },
      },
      sendChannel: {
        frames: 4,
        bytes: 1_850,
        snapshots: 1,
        keepalives: 1,
        critical: 1,
        other: 1,
        bytesByKind: {
          snapshots: 1_600,
          keepalives: 120,
          critical: 80,
          other: 50,
        },
        failed: {
          frames: 0,
          bytes: 0,
        },
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
        windowAgeMs: 50,
      },
      sinceOutboundProof: {
        sentFrames: 4,
        sentBytes: 1_850,
        receivedFrames: 2,
        receivedBytes: 250,
        sentSnapshots: 1,
        sentKeepalives: 1,
        sentCritical: 1,
        sentOther: 1,
        windowAgeMs: 75,
      },
      outboundProof: {
        total: 0,
        bySource: {
          deliveryProbeEcho: 0,
          criticalAck: 0,
          criticalCursor: 0,
          snapshotCursor: 0,
          clockPong: 0,
        },
        deliveryProbe: {
          sent: 0,
          echoed: 0,
        },
      },
      pump: {
        lastGapMs: 45,
        maxGapMs: 45,
        windowAgeMs: 50,
        maxGapSessionMs: 45,
      },
      rtt: {
        samples: 0,
      },
      authenticatedInterarrival: {
        samples: 0,
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
        retransmits: 0,
        gapRequests: 0,
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

    const populatedSummary = telemetry.snapshot();
    expect(populatedSummary).toMatchObject({
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
    expect(parseNetworkTelemetrySummary(populatedSummary)).toEqual(
      populatedSummary,
    );
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
      windowAgeMs: 0,
    });
  });

  it("rolls back only the original send after reentrant window resets", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(4_500) });
    telemetry.noteChannelAttached();

    const rejected = telemetry.noteSent(100, "ACK");
    telemetry.noteAuthenticatedReceived(80, "KEEPALIVE");
    telemetry.noteOutboundDeliveryProof("critical-ack", { cursor: 1 });
    telemetry.noteSent(50, "KEEPALIVE");
    telemetry.noteSendFailed(100, "ACK", rejected);

    expect(telemetry.snapshot()).toMatchObject({
      send: {
        frames: 1,
        bytes: 50,
        snapshots: 0,
        keepalives: 1,
        critical: 0,
        other: 0,
        failed: { frames: 1, bytes: 100 },
      },
      sendChannel: {
        frames: 1,
        bytes: 50,
        snapshots: 0,
        keepalives: 1,
        critical: 0,
        other: 0,
        failed: { frames: 1, bytes: 100 },
      },
      sinceAuthenticated: {
        sentFrames: 1,
        sentBytes: 50,
        sentSnapshots: 0,
        sentKeepalives: 1,
        sentCritical: 0,
        sentOther: 0,
      },
      sinceOutboundProof: {
        sentFrames: 1,
        sentBytes: 50,
        sentSnapshots: 0,
        sentKeepalives: 1,
        sentCritical: 0,
        sentOther: 0,
      },
    });
  });

  it("does not charge a departed channel for a rejected earlier send", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(4_750) });
    telemetry.noteChannelAttached();

    const rejected = telemetry.noteSent(100, "ACK");
    telemetry.noteChannelAttached();
    telemetry.noteSent(50, "KEEPALIVE");
    telemetry.noteSendFailed(100, "ACK", rejected);

    expect(telemetry.snapshot()).toMatchObject({
      send: {
        frames: 1,
        bytes: 50,
        failed: { frames: 1, bytes: 100 },
      },
      sendChannel: {
        frames: 1,
        bytes: 50,
        keepalives: 1,
        other: 0,
        failed: { frames: 0, bytes: 0 },
      },
    });
  });

  it("retains successful outbound totals for the full session", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(5_000) });

    telemetry.noteSent(120, "KEEPALIVE");
    telemetry.noteAuthenticatedReceived(80);
    telemetry.noteSent(1_600, "SNAPSHOT");
    telemetry.noteSendFailed(1_600, "SNAPSHOT");
    telemetry.noteSent(80, "GARBAGE_ATTACK");
    telemetry.noteSent(50, "ACK");

    expect(telemetry.snapshot()).toMatchObject({
      send: {
        frames: 3,
        bytes: 250,
        snapshots: 0,
        keepalives: 1,
        critical: 1,
        other: 1,
      },
    });
  });

  it("reports authenticated and pump window ages without erasing the session pump maximum", () => {
    const clock = new ManualClock(6_000);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.notePump();
    clock.advance(1_000);
    telemetry.noteAuthenticatedReceived(80);
    telemetry.notePump();
    clock.advance(50);
    telemetry.notePump();

    expect(telemetry.snapshot()).toMatchObject({
      sinceAuthenticated: {
        windowAgeMs: 50,
      },
      pump: {
        lastGapMs: 50,
        maxGapMs: 50,
        windowAgeMs: 50,
        maxGapSessionMs: 1_000,
      },
    });
  });

  it("keeps the authenticated traffic window across channel generations", () => {
    const clock = new ManualClock(6_500);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.noteChannelAttached();
    telemetry.noteRawReceived(80);
    telemetry.noteDecodedReceived(80);
    telemetry.noteAuthenticatedReceived(80);
    clock.advance(20);
    telemetry.noteChannelDetached();
    telemetry.noteChannelAttached();
    clock.advance(30);

    const summary = telemetry.snapshot();
    expect(summary.receive.authenticatedAgeMs).toBeUndefined();
    expect(summary.sinceAuthenticated.windowAgeMs).toBe(50);
  });

  it("retains cumulative receive totals and authenticated inter-arrival timing across channels", () => {
    const clock = new ManualClock(8_000);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.noteChannelAttached();
    telemetry.noteRawReceived(100);
    telemetry.noteDecodedReceived(100);
    telemetry.noteAuthenticatedReceived(100);
    clock.advance(20);
    telemetry.noteRawReceived(10);
    telemetry.noteChannelDetached();
    telemetry.noteChannelAttached();
    clock.advance(280);
    telemetry.noteRawReceived(40);
    telemetry.noteDecodedReceived(40);
    telemetry.noteAuthenticatedReceived(40);

    expect(telemetry.snapshot()).toMatchObject({
      receive: {
        rawFrames: 1,
        rawBytes: 40,
        decodedFrames: 1,
        decodedBytes: 40,
        authenticatedFrames: 1,
        authenticatedBytes: 40,
      },
      receiveSession: {
        rawFrames: 3,
        rawBytes: 150,
        decodedFrames: 2,
        decodedBytes: 140,
        authenticatedFrames: 2,
        authenticatedBytes: 140,
      },
      authenticatedInterarrival: {
        samples: 1,
        latestMs: 300,
        minMs: 300,
        maxMs: 300,
        smoothedMs: 300,
        jitterMs: 0,
      },
    });
  });

  it("tracks successful bytes by kind separately from rejected sends", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(9_000) });

    telemetry.noteSent(1_600, "SNAPSHOT");
    telemetry.noteSent(120, "KEEPALIVE");
    telemetry.noteSent(80, "GARBAGE_ATTACK");
    telemetry.noteSent(50, "ACK");
    telemetry.noteSendFailed(1_600, "SNAPSHOT");

    expect(telemetry.snapshot().send).toEqual({
      frames: 3,
      bytes: 250,
      snapshots: 0,
      keepalives: 1,
      critical: 1,
      other: 1,
      bytesByKind: {
        snapshots: 0,
        keepalives: 120,
        critical: 80,
        other: 50,
      },
      failed: {
        frames: 1,
        bytes: 1_600,
      },
    });
  });

  it("summarizes round-trip samples with bounded smoothed latency and jitter", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(10_000) });

    telemetry.noteRoundTrip(100);
    telemetry.noteRoundTrip(140);
    telemetry.noteRoundTrip(80);

    expect(telemetry.snapshot().rtt).toEqual({
      samples: 3,
      latestMs: 80,
      minMs: 80,
      maxMs: 140,
      smoothedMs: 102,
      jitterMs: 14,
    });
    expect(() => telemetry.noteRoundTrip(Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it("counts reliability retransmits and gap requests without retaining events", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(11_000) });

    telemetry.noteCriticalRetransmit();
    telemetry.noteCriticalRetransmit(2);
    telemetry.noteGapRequest();
    telemetry.noteGapRequest(3);

    expect(telemetry.snapshot().critical).toEqual({
      pending: 0,
      maxPending: 0,
      retransmits: 3,
      gapRequests: 4,
    });
  });

  it("separates current-channel health from session-wide outbound proof telemetry", () => {
    const clock = new ManualClock(12_000);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.noteChannelAttached();
    telemetry.noteSent(120, "KEEPALIVE");
    telemetry.noteDeliveryProbeSent(7);
    clock.advance(40);
    telemetry.noteRawReceived(80);
    telemetry.noteDecodedReceived(80);
    telemetry.noteAuthenticatedReceived(80);
    telemetry.noteDeliveryProbeEchoed(7);
    clock.advance(10);
    telemetry.noteSent(1_600, "SNAPSHOT");
    telemetry.noteSendFailed(1_600, "SNAPSHOT");
    telemetry.noteSent(50, "ACK");
    telemetry.noteSnapshotFlow(30, 4);
    clock.advance(20);

    const proofSummary = telemetry.snapshot();
    expect(proofSummary).toMatchObject({
      channel: {
        generation: 1,
        currentGenerationInbound: true,
        currentGenerationOutboundProof: true,
      },
      sendChannel: {
        frames: 2,
        bytes: 170,
        snapshots: 0,
        keepalives: 1,
        critical: 0,
        other: 1,
        failed: { frames: 1, bytes: 1_600 },
      },
      outboundProof: {
        total: 1,
        ageMs: 30,
        bySource: {
          deliveryProbeEcho: 1,
          criticalAck: 0,
          criticalCursor: 0,
          snapshotCursor: 0,
          clockPong: 0,
        },
        deliveryProbe: {
          sent: 1,
          echoed: 1,
          lastSentSeq: 7,
          lastSentAgeMs: 70,
          lastEchoedSeq: 7,
          lastEchoedAgeMs: 30,
        },
      },
      sinceOutboundProof: {
        sentFrames: 1,
        sentBytes: 50,
        receivedFrames: 0,
        receivedBytes: 0,
        sentSnapshots: 0,
        sentKeepalives: 0,
        sentCritical: 0,
        sentOther: 1,
        windowAgeMs: 30,
      },
      snapshots: {
        activeIntervalTicks: 30,
        deliveryLag: 4,
      },
    });
    expect(parseNetworkTelemetrySummary(proofSummary)).toEqual(proofSummary);

    telemetry.noteChannelDetached();
    telemetry.noteChannelAttached();
    expect(telemetry.snapshot()).toMatchObject({
      channel: {
        generation: 2,
        currentGenerationInbound: false,
        currentGenerationOutboundProof: false,
      },
      sendChannel: {
        frames: 0,
        bytes: 0,
        failed: { frames: 0, bytes: 0 },
      },
      outboundProof: {
        total: 1,
        bySource: { deliveryProbeEcho: 1 },
      },
    });
  });

  it("rolls back rejected delivery probes without clobbering reentrant success", () => {
    const clock = new ManualClock(12_000);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.noteDeliveryProbeSent(1);
    clock.advance(10);
    const rejected = telemetry.noteDeliveryProbeSent(2);
    clock.advance(10);
    telemetry.noteDeliveryProbeSent(3);
    telemetry.noteDeliveryProbeSendFailed(rejected);

    expect(telemetry.snapshot().outboundProof?.deliveryProbe).toMatchObject({
      sent: 2,
      lastSentSeq: 3,
      lastSentAgeMs: 0,
    });

    clock.advance(10);
    const secondRejected = telemetry.noteDeliveryProbeSent(4);
    telemetry.noteDeliveryProbeSendFailed(secondRejected);

    expect(telemetry.snapshot().outboundProof?.deliveryProbe).toMatchObject({
      sent: 2,
      lastSentSeq: 3,
      lastSentAgeMs: 10,
    });
  });

  it("counts each bounded outbound-proof source without retaining events", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(13_000) });

    telemetry.noteOutboundDeliveryProof("critical-ack");
    telemetry.noteOutboundDeliveryProof("critical-cursor");
    telemetry.noteOutboundDeliveryProof("snapshot-cursor");
    telemetry.noteOutboundDeliveryProof("clock-pong");

    expect(telemetry.snapshot().outboundProof).toMatchObject({
      total: 4,
      bySource: {
        deliveryProbeEcho: 0,
        criticalAck: 1,
        criticalCursor: 1,
        snapshotCursor: 1,
        clockPong: 1,
      },
    });
    expect(() => telemetry.noteDeliveryProbeSent(-1)).toThrow(RangeError);
    expect(() => telemetry.noteSnapshotFlow(30, -1)).toThrow(RangeError);
  });

  it("records ambiguous delivery evidence without proving the current channel", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(13_125) });
    telemetry.noteChannelAttached();

    telemetry.noteOutboundDeliveryProof(
      "critical-ack",
      { cursor: 7 },
      false,
    );

    expect(telemetry.snapshot()).toMatchObject({
      channel: { currentGenerationOutboundProof: false },
      outboundProof: {
        total: 1,
        bySource: { criticalAck: 1 },
        criticalAck: { lastCursor: 7 },
      },
    });
  });

  it("retains one age and optional cursor or sample for each outbound-proof source", () => {
    const clock = new ManualClock(13_250);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.noteOutboundDeliveryProof("critical-ack", { cursor: 11 });
    clock.advance(10);
    telemetry.noteOutboundDeliveryProof("critical-cursor", { cursor: 17 });
    clock.advance(10);
    telemetry.noteOutboundDeliveryProof("snapshot-cursor", { cursor: 23 });
    clock.advance(10);
    telemetry.noteOutboundDeliveryProof("clock-pong", { sampleId: 29 });
    clock.advance(20);

    const summary = telemetry.snapshot();
    expect(summary.outboundProof).toMatchObject({
      criticalAck: { lastAgeMs: 50, lastCursor: 11 },
      criticalCursor: { lastAgeMs: 40, lastCursor: 17 },
      snapshotCursor: { lastAgeMs: 30, lastCursor: 23 },
      clockPong: { lastAgeMs: 20, lastSampleId: 29 },
    });
    expect(parseNetworkTelemetrySummary(summary)).toEqual(summary);

    const cloned = cloneNetworkTelemetrySummary(summary);
    cloned.outboundProof!.criticalAck!.lastCursor = 99;
    cloned.outboundProof!.clockPong!.lastSampleId = 99;
    expect(summary.outboundProof?.criticalAck?.lastCursor).toBe(11);
    expect(summary.outboundProof?.clockPong?.lastSampleId).toBe(29);

    const legacyProofSummary = cloneNetworkTelemetrySummary(summary);
    delete legacyProofSummary.outboundProof!.criticalAck;
    delete legacyProofSummary.outboundProof!.criticalCursor;
    delete legacyProofSummary.outboundProof!.snapshotCursor;
    delete legacyProofSummary.outboundProof!.clockPong;
    expect(parseNetworkTelemetrySummary(legacyProofSummary)).toEqual(
      legacyProofSummary,
    );
  });

  it("distinguishes suspended snapshots from an uninstrumented snapshot cadence", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(13_500) });

    expect(telemetry.snapshot().snapshots).not.toHaveProperty(
      "activeIntervalTicks",
    );
    telemetry.noteSnapshotFlow(null, 6);

    const suspended = telemetry.snapshot();
    expect(suspended.snapshots).toMatchObject({
      activeIntervalTicks: null,
      deliveryLag: 6,
    });
    expect(parseNetworkTelemetrySummary(suspended)).toEqual(suspended);

    telemetry.noteSnapshotFlow(30, 2);
    expect(telemetry.snapshot().snapshots).toMatchObject({
      activeIntervalTicks: 30,
      deliveryLag: 2,
    });
  });

  it("keeps fixed per-kind authenticated receive counts for the channel and session", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(14_000) });

    telemetry.noteChannelAttached();
    telemetry.noteAuthenticatedReceived(10, "SNAPSHOT");
    telemetry.noteAuthenticatedReceived(10, "KEEPALIVE");
    telemetry.noteAuthenticatedReceived(10, "CLOCK_PING");
    telemetry.noteAuthenticatedReceived(10, "CLOCK_PONG");
    telemetry.noteAuthenticatedReceived(10, "ACK");
    telemetry.noteAuthenticatedReceived(10, "NETWORK_PAUSE");
    telemetry.noteAuthenticatedReceived(10, "HELLO");

    expect(telemetry.snapshot()).toMatchObject({
      receive: {
        byKind: {
          snapshots: 1,
          keepalives: 1,
          clockPings: 1,
          clockPongs: 1,
          acks: 1,
          critical: 1,
          other: 1,
        },
      },
      receiveSession: {
        byKind: {
          snapshots: 1,
          keepalives: 1,
          clockPings: 1,
          clockPongs: 1,
          acks: 1,
          critical: 1,
          other: 1,
        },
      },
    });

    telemetry.noteChannelDetached();
    telemetry.noteChannelAttached();
    telemetry.noteAuthenticatedReceived(10);
    expect(telemetry.snapshot()).toMatchObject({
      receive: { byKind: { other: 1 } },
      receiveSession: { byKind: { other: 2 } },
    });
  });

  it("round-trips and clones additive telemetry scopes", () => {
    const clock = new ManualClock(7_000);
    const telemetry = new NetworkTelemetry({ clock });

    telemetry.notePump();
    clock.advance(20);
    telemetry.noteRawReceived(80);
    telemetry.noteDecodedReceived(80);
    telemetry.noteAuthenticatedReceived(80);
    telemetry.noteSent(120, "KEEPALIVE");
    clock.advance(30);
    telemetry.notePump();
    const summary = telemetry.snapshot();

    expect(parseNetworkTelemetrySummary(summary)).toEqual(summary);
    const cloned = cloneNetworkTelemetrySummary(summary);
    expect(cloned).toEqual(summary);
    cloned.send!.frames = 99;
    cloned.sendChannel!.frames = 99;
    cloned.send!.bytesByKind!.snapshots = 99;
    cloned.outboundProof!.bySource.clockPong = 99;
    cloned.outboundProof!.deliveryProbe.sent = 99;
    cloned.sinceOutboundProof!.sentFrames = 99;
    cloned.receiveSession!.rawFrames = 99;
    cloned.receiveSession!.byKind!.other = 99;
    cloned.receive.byKind!.other = 99;
    cloned.rtt!.samples = 99;
    cloned.authenticatedInterarrival!.samples = 99;
    expect(summary.send?.frames).toBe(1);
    expect(summary.sendChannel?.frames).toBe(1);
    expect(summary.send?.bytesByKind?.snapshots).toBe(0);
    expect(summary.outboundProof?.bySource.clockPong).toBe(0);
    expect(summary.outboundProof?.deliveryProbe.sent).toBe(0);
    expect(summary.sinceOutboundProof?.sentFrames).toBe(1);
    expect(summary.receiveSession?.rawFrames).toBe(1);
    expect(summary.receiveSession?.byKind?.other).toBe(1);
    expect(summary.receive.byKind?.other).toBe(1);
    expect(summary.rtt?.samples).toBe(0);
    expect(summary.authenticatedInterarrival?.samples).toBe(0);
  });

  it("rejects authenticated windows larger than session receive totals", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(14_500) });
    telemetry.noteChannelAttached();
    telemetry.noteRawReceived(80);
    telemetry.noteDecodedReceived(80);
    telemetry.noteAuthenticatedReceived(80, "KEEPALIVE");

    const invalidFrames = telemetry.snapshot();
    invalidFrames.sinceAuthenticated.receivedFrames = 2;
    expect(parseNetworkTelemetrySummary(invalidFrames)).toBeUndefined();

    const invalidBytes = telemetry.snapshot();
    invalidBytes.sinceAuthenticated.receivedBytes = 81;
    expect(parseNetworkTelemetrySummary(invalidBytes)).toBeUndefined();
  });

  it("rejects channel receive kinds larger than their session kinds", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(14_750) });
    telemetry.noteChannelAttached();
    for (const kind of [
      "SNAPSHOT",
      "KEEPALIVE",
      "CLOCK_PING",
      "CLOCK_PONG",
      "ACK",
      "NETWORK_PAUSE",
      "HELLO",
    ] as const) {
      telemetry.noteRawReceived(10);
      telemetry.noteDecodedReceived(10);
      telemetry.noteAuthenticatedReceived(10, kind);
    }

    for (const category of [
      "snapshots",
      "keepalives",
      "clockPings",
      "clockPongs",
      "acks",
      "critical",
      "other",
    ] as const) {
      const invalid = cloneNetworkTelemetrySummary(telemetry.snapshot());
      const replacement = category === "other" ? "snapshots" : "other";
      invalid.receiveSession!.byKind![category] -= 1;
      invalid.receiveSession!.byKind![replacement] += 1;
      expect(parseNetworkTelemetrySummary(invalid)).toBeUndefined();
    }
  });

  it("rejects channel send-kind bytes larger than session send-kind bytes", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(14_875) });
    telemetry.noteChannelAttached();
    for (const kind of [
      "SNAPSHOT",
      "KEEPALIVE",
      "GARBAGE_ATTACK",
      "ACK",
    ] as const) {
      telemetry.noteSent(1, kind);
    }
    telemetry.noteChannelDetached();
    telemetry.noteChannelAttached();
    for (const kind of [
      "SNAPSHOT",
      "KEEPALIVE",
      "GARBAGE_ATTACK",
      "ACK",
    ] as const) {
      telemetry.noteSent(1_000, kind);
    }

    for (const category of [
      "snapshots",
      "keepalives",
      "critical",
      "other",
    ] as const) {
      const invalid = cloneNetworkTelemetrySummary(telemetry.snapshot());
      const replacement = category === "other" ? "snapshots" : "other";
      invalid.sendChannel!.bytesByKind![category] = 1_002;
      invalid.sendChannel!.bytesByKind![replacement] = 998;
      expect(parseNetworkTelemetrySummary(invalid)).toBeUndefined();
    }
  });

  it("rejects mismatched outbound-proof and proof-window ages", () => {
    const clock = new ManualClock(14_900);
    const telemetry = new NetworkTelemetry({ clock });
    telemetry.noteChannelAttached();
    telemetry.noteOutboundDeliveryProof("critical-ack", { cursor: 3 });
    clock.advance(20);

    const invalidProofAge = telemetry.snapshot();
    invalidProofAge.outboundProof!.ageMs = 21;
    expect(parseNetworkTelemetrySummary(invalidProofAge)).toBeUndefined();

    const invalidWindowAge = telemetry.snapshot();
    invalidWindowAge.sinceOutboundProof!.windowAgeMs = 21;
    expect(parseNetworkTelemetrySummary(invalidWindowAge)).toBeUndefined();
  });

  it("rejects delivery-probe proof counts that disagree with echoed probes", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(14_925) });
    telemetry.noteChannelAttached();
    telemetry.noteDeliveryProbeSent(1);
    telemetry.noteDeliveryProbeEchoed(1);

    const invalid = telemetry.snapshot();
    invalid.outboundProof!.deliveryProbe.echoed = 0;
    delete invalid.outboundProof!.deliveryProbe.lastEchoedSeq;
    delete invalid.outboundProof!.deliveryProbe.lastEchoedAgeMs;

    expect(parseNetworkTelemetrySummary(invalid)).toBeUndefined();
  });

  it("keeps additive telemetry detail blocks independently optional", () => {
    const clock = new ManualClock(14_950);
    const telemetry = new NetworkTelemetry({ clock });
    telemetry.noteChannelAttached();
    telemetry.noteRawReceived(80);
    telemetry.noteDecodedReceived(80);
    telemetry.noteAuthenticatedReceived(80, "KEEPALIVE");
    telemetry.noteSent(120, "KEEPALIVE");
    telemetry.noteOutboundDeliveryProof("critical-ack", { cursor: 5 });
    clock.advance(10);

    const candidates = Array.from({ length: 5 }, () =>
      cloneNetworkTelemetrySummary(telemetry.snapshot())
    );
    delete candidates[0]!.receive.byKind;
    delete candidates[1]!.receiveSession!.byKind;
    delete candidates[2]!.send!.bytesByKind;
    delete candidates[3]!.sendChannel!.bytesByKind;
    delete candidates[4]!.sinceOutboundProof!.windowAgeMs;

    for (const candidate of candidates) {
      expect(parseNetworkTelemetrySummary(candidate)).toEqual(candidate);
    }
  });

  it("rejects inconsistent fixed-cardinality telemetry extensions", () => {
    const telemetry = new NetworkTelemetry({ clock: new ManualClock(15_000) });
    telemetry.noteChannelAttached();
    telemetry.noteSent(120, "KEEPALIVE");
    telemetry.noteAuthenticatedReceived(80, "KEEPALIVE");
    telemetry.noteOutboundDeliveryProof("critical-ack");
    telemetry.noteSnapshotFlow(30, 2);

    const invalidReceiveKinds = telemetry.snapshot();
    invalidReceiveKinds.receive.byKind!.other = 1;
    expect(parseNetworkTelemetrySummary(invalidReceiveKinds)).toBeUndefined();

    const invalidProofSources = telemetry.snapshot();
    invalidProofSources.outboundProof!.bySource.clockPong = 1;
    expect(parseNetworkTelemetrySummary(invalidProofSources)).toBeUndefined();

    const invalidProofMetadata = telemetry.snapshot();
    invalidProofMetadata.outboundProof!.criticalAck!.lastCursor = -1;
    expect(parseNetworkTelemetrySummary(invalidProofMetadata)).toBeUndefined();

    const invalidChannelSend = telemetry.snapshot();
    invalidChannelSend.sendChannel!.frames = 2;
    expect(parseNetworkTelemetrySummary(invalidChannelSend)).toBeUndefined();

    const incompleteSnapshotFlow = telemetry.snapshot();
    delete incompleteSnapshotFlow.snapshots.deliveryLag;
    expect(parseNetworkTelemetrySummary(incompleteSnapshotFlow)).toBeUndefined();
  });

  it("parses legacy summaries without additive telemetry scopes", () => {
    const legacy = {
      channel: {
        generation: 0,
        attached: false,
      },
      receive: {
        rawFrames: 0,
        rawBytes: 0,
        decodedFrames: 0,
        decodedBytes: 0,
        authenticatedFrames: 0,
        authenticatedBytes: 0,
      },
      sinceAuthenticated: {
        sentFrames: 0,
        sentBytes: 0,
        receivedFrames: 0,
        receivedBytes: 0,
        sentSnapshots: 0,
        sentKeepalives: 0,
        sentCritical: 0,
        sentOther: 0,
      },
      pump: {
        lastGapMs: 0,
        maxGapMs: 0,
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
    };

    expect(parseNetworkTelemetrySummary(legacy)).toEqual(legacy);
  });
});
