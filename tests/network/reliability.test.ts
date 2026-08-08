import { describe, expect, it } from "vitest";

import { decodeEnvelope, encodeEnvelope } from "../../src/network/codec";
import { InMemoryRealtimeBus, ManualClock } from "../../src/network/in-memory";
import {
  CRITICAL_INITIAL_RETRANSMIT_MS,
  CriticalReliability,
  PeerLiveness,
  type CriticalAcknowledgement,
} from "../../src/network/reliability";
import type {
  CriticalApplicationOutcome,
  CriticalKind,
  RealtimeEnvelope,
  StreamRef,
} from "../../src/network/messages";

function createPair(
  onApplyB?: (
    frame: RealtimeEnvelope<CriticalKind>,
    sender: CriticalReliability,
  ) => CriticalApplicationOutcome | void,
  onAcknowledgedA?: (acknowledgement: CriticalAcknowledgement) => void,
  requireApplicationReceiptKinds: readonly CriticalKind[] = [],
) {
  const clock = new ManualClock();
  const bus = new InMemoryRealtimeBus();
  const endpointA = bus.connect("a");
  const endpointB = bus.connect("b");
  const streamA: StreamRef = { senderId: "player-a", sessionId: "session-a" };
  const streamB: StreamRef = { senderId: "player-b", sessionId: "session-b" };
  const appliedA: RealtimeEnvelope<CriticalKind>[] = [];
  const appliedB: RealtimeEnvelope<CriticalKind>[] = [];

  let a: CriticalReliability;
  a = new CriticalReliability({
    matchId: "match-1",
    identity: streamA,
    peer: streamB,
    clock,
    getMatchTick: () => 120,
    send: (frame) => endpointA.send(encodeEnvelope(frame)),
    apply: (frame) => {
      appliedA.push(frame);
    },
    ...(onAcknowledgedA === undefined
      ? {}
      : { onAcknowledged: onAcknowledgedA }),
    requireApplicationReceiptKinds,
  });
  const b = new CriticalReliability({
    matchId: "match-1",
    identity: streamB,
    peer: streamA,
    clock,
    getMatchTick: () => 120,
    send: (frame) => endpointB.send(encodeEnvelope(frame)),
    apply: (frame) => {
      appliedB.push(frame);
      return onApplyB?.(frame, a);
    },
  });

  endpointA.setListener((bytes) => {
    const decoded = decodeEnvelope(bytes, { expectedMatchId: "match-1" });
    if (decoded.ok) a.receive(decoded.value);
  });
  endpointB.setListener((bytes) => {
    const decoded = decodeEnvelope(bytes, { expectedMatchId: "match-1" });
    if (decoded.ok) b.receive(decoded.value);
  });

  return { clock, bus, a, b, appliedA, appliedB };
}

function createDelayedPair(oneWayDelayMs: number) {
  const clock = new ManualClock();
  const streamA: StreamRef = { senderId: "player-a", sessionId: "session-a" };
  const streamB: StreamRef = { senderId: "player-b", sessionId: "session-b" };
  const appliedB: RealtimeEnvelope<CriticalKind>[] = [];
  const queued: Array<{
    deliverAtMs: number;
    receiver: "a" | "b";
    envelope: RealtimeEnvelope;
  }> = [];
  let sentByA = 0;
  let sentByB = 0;
  let dropsFromA = 0;
  let a!: CriticalReliability;
  let b!: CriticalReliability;
  a = new CriticalReliability({
    matchId: "match-1",
    identity: streamA,
    peer: streamB,
    clock,
    getMatchTick: () => 120,
    send: (envelope) => {
      sentByA += 1;
      if (dropsFromA > 0) {
        dropsFromA -= 1;
        return;
      }
      queued.push({
        deliverAtMs: clock.now() + oneWayDelayMs,
        receiver: "b",
        envelope,
      });
    },
    apply: () => undefined,
  });
  b = new CriticalReliability({
    matchId: "match-1",
    identity: streamB,
    peer: streamA,
    clock,
    getMatchTick: () => 120,
    send: (envelope) => {
      sentByB += 1;
      queued.push({
        deliverAtMs: clock.now() + oneWayDelayMs,
        receiver: "a",
        envelope,
      });
    },
    apply: (envelope) => {
      appliedB.push(envelope);
    },
  });

  const deliverDue = () => {
    for (let index = 0; index < queued.length;) {
      const delivery = queued[index];
      if (delivery === undefined || delivery.deliverAtMs > clock.now()) {
        index += 1;
        continue;
      }
      queued.splice(index, 1);
      (delivery.receiver === "a" ? a : b).receive(delivery.envelope);
    }
  };
  const advance = (milliseconds: number, stepMs = 50) => {
    let remaining = milliseconds;
    while (remaining > 0) {
      const amount = Math.min(stepMs, remaining);
      clock.advance(amount);
      deliverDue();
      a.pump();
      b.pump();
      deliverDue();
      remaining -= amount;
    }
  };

  return {
    a,
    appliedB,
    advance,
    dropNextFromA: () => {
      dropsFromA += 1;
    },
    sentCounts: () => ({ a: sentByA, b: sentByB }),
  };
}

describe("critical realtime reliability", () => {
  it("reports a reentrant acknowledgement after committing the outbox state", () => {
    const observations: Array<{
      eventId: string;
      sequence: number;
      kind: CriticalKind;
      source: "ack" | "cursor";
      peerAcknowledgedAtMonotonicMs?: number;
      beforeSendReturned: boolean;
      pending: boolean;
    }> = [];
    let sendReturned = false;
    let sender!: CriticalReliability;
    const pair = createPair(undefined, (acknowledgement) => {
      observations.push({
        ...acknowledgement,
        beforeSendReturned: !sendReturned,
        pending: sender.isEventPending(acknowledgement.eventId),
      });
    });
    sender = pair.a;

    sender.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-acknowledged", targetPlayerId: "player-b" },
      120,
    );
    sendReturned = true;

    expect(observations).toEqual([
      {
        eventId: "cross-acknowledged",
        sequence: 1,
        kind: "HOLLOW_CROSS",
        source: "ack",
        peerAcknowledgedAtMonotonicMs: 0,
        beforeSendReturned: true,
        pending: false,
      },
    ]);
  });

  it("reports cursor acknowledgements once through the same public event", () => {
    const acknowledgements: Array<{
      eventId: string;
      sequence: number;
      kind: CriticalKind;
      source: "ack" | "cursor";
    }> = [];
    const { a, bus } = createPair(undefined, (acknowledgement) => {
      acknowledgements.push(acknowledgement);
    });
    bus.dropNext("a", "b");
    a.sendCritical(
      "GLITCH_PIECE",
      { eventId: "glitch-cursor", targetPlayerId: "player-b" },
      120,
    );

    const cursor = {
      stream: { senderId: "player-a", sessionId: "session-a" },
      contiguousThrough: 1,
    } as const;
    a.acknowledgeCursor(cursor);
    a.acknowledgeCursor(cursor);

    expect(acknowledgements).toEqual([
      {
        eventId: "glitch-cursor",
        sequence: 1,
        kind: "GLITCH_PIECE",
        source: "cursor",
      },
    ]);
    expect(a.isEventPending("glitch-cursor")).toBe(false);
  });

  it("does not let a cumulative cursor retire a critical event that needs a semantic receipt", () => {
    const pair = createPair(
      () => "accepted",
      undefined,
      ["START_COMMIT"],
    );
    pair.bus.dropNext("b", "a");
    pair.a.sendCritical(
      "START_COMMIT",
      {
        eventId: "commit-explicit-receipt",
        proposalEventId: "proposal-1",
        epoch: 0,
        startAtCoordinatorMs: 3_000,
        startTick: 0,
        configHash: "config-1",
      },
      0,
    );

    pair.a.acknowledgeCursor({
      stream: { senderId: "player-a", sessionId: "session-a" },
      contiguousThrough: 1,
    });

    expect(pair.a.pendingCount).toBe(1);
  });

  it("repeats the original semantic receipt when the first ACK is lost", () => {
    const acknowledgements: CriticalAcknowledgement[] = [];
    const pair = createPair(
      () => "accepted",
      (acknowledgement) => acknowledgements.push(acknowledgement),
      ["START_COMMIT"],
    );
    pair.bus.dropNext("b", "a");
    pair.a.sendCritical(
      "START_COMMIT",
      {
        eventId: "commit-retried-receipt",
        proposalEventId: "proposal-1",
        epoch: 0,
        startAtCoordinatorMs: 3_000,
        startTick: 0,
        configHash: "config-1",
      },
      0,
    );
    pair.clock.advance(CRITICAL_INITIAL_RETRANSMIT_MS);
    pair.a.pump();

    expect(pair.appliedB).toHaveLength(1);
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]?.applicationReceipt).toEqual({
      sequence: 1,
      outcome: "accepted",
      processedAtMonotonicMs: 0,
    });
    expect(pair.a.pendingCount).toBe(0);
  });

  it("keeps a receipt-required event pending when application produced no decision", () => {
    const pair = createPair(
      () => {
        throw new Error("injected application failure");
      },
      undefined,
      ["START_COMMIT"],
    );

    expect(() =>
      pair.a.sendCritical(
        "START_COMMIT",
        {
          eventId: "commit-without-receipt",
          proposalEventId: "proposal-1",
          epoch: 0,
          startAtCoordinatorMs: 3_000,
          startTick: 0,
          configHash: "config-1",
        },
        0,
      ),
    ).toThrow("injected application failure");
    expect(pair.a.pendingCount).toBe(1);

    pair.clock.advance(CRITICAL_INITIAL_RETRANSMIT_MS);
    pair.a.pump();

    expect(pair.a.pendingCount).toBe(1);
  });

  it("does not retransmit before a first 800 ms round trip completes", () => {
    const pair = createDelayedPair(400);

    pair.a.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-high-rtt", targetPlayerId: "player-b" },
      120,
    );
    pair.advance(800);

    expect(pair.appliedB.map((frame) => frame.payload.eventId)).toEqual([
      "cross-high-rtt",
    ]);
    expect(pair.sentCounts()).toEqual({ a: 1, b: 1 });
    expect(pair.a.isEventPending("cross-high-rtt")).toBe(false);
  });

  it("uses an unambiguous round trip to tune the next event timeout", () => {
    const pair = createDelayedPair(100);
    pair.a.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-rtt-sample", targetPlayerId: "player-b" },
      120,
    );
    pair.advance(200);
    expect(pair.a.isEventPending("cross-rtt-sample")).toBe(false);

    pair.dropNextFromA();
    pair.a.sendCritical(
      "GLITCH_PIECE",
      { eventId: "glitch-after-sample", targetPlayerId: "player-b" },
      121,
    );
    pair.advance(599);
    expect(pair.sentCounts()).toEqual({ a: 2, b: 1 });

    pair.advance(1);
    expect(pair.sentCounts()).toEqual({ a: 3, b: 1 });
    pair.advance(200);
    expect(pair.appliedB.map((frame) => frame.payload.eventId)).toEqual([
      "cross-rtt-sample",
      "glitch-after-sample",
    ]);
    expect(pair.a.isEventPending("glitch-after-sample")).toBe(false);
  });

  it("reports RTT, retransmit, and gap-request observations", () => {
    const clock = new ManualClock();
    const roundTrips: number[] = [];
    let retransmits = 0;
    let gapRequests = 0;
    const sender = new CriticalReliability({
      matchId: "match-1",
      identity: { senderId: "player-a", sessionId: "session-a" },
      peer: { senderId: "player-b", sessionId: "session-b" },
      clock,
      getMatchTick: () => 120,
      send: () => undefined,
      apply: () => undefined,
      onRoundTrip: (milliseconds) => roundTrips.push(milliseconds),
      onRetransmit: () => {
        retransmits += 1;
      },
      onGapRequest: () => {
        gapRequests += 1;
      },
    });
    sender.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-observed", targetPlayerId: "player-b" },
      120,
    );
    clock.advance(100);
    sender.receive({
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "ACK",
      matchTick: 120,
      sentAtMonotonicMs: 100,
      payload: {
        stream: { senderId: "player-a", sessionId: "session-a" },
        seqs: [1],
      },
    });
    expect(roundTrips).toEqual([100]);

    sender.sendCritical(
      "GLITCH_PIECE",
      { eventId: "glitch-retried", targetPlayerId: "player-b" },
      121,
    );
    clock.advance(300);
    sender.pump();
    expect(retransmits).toBe(1);

    sender.receive({
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "HOLLOW_CROSS",
      seq: 2,
      matchTick: 121,
      sentAtMonotonicMs: 400,
      payload: { eventId: "peer-cross-2", targetPlayerId: "player-a" },
    });
    expect(gapRequests).toBe(1);
  });

  it("does not sample an acknowledgement after an immediate gap resend", () => {
    const pair = createDelayedPair(100);
    pair.a.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-baseline-rtt", targetPlayerId: "player-b" },
      120,
    );
    pair.advance(200);

    pair.dropNextFromA();
    pair.a.sendCritical(
      "GLITCH_PIECE",
      { eventId: "glitch-gap-retried", targetPlayerId: "player-b" },
      121,
    );
    pair.a.receive({
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "GAP_REQUEST",
      matchTick: 121,
      sentAtMonotonicMs: 200,
      payload: {
        stream: { senderId: "player-a", sessionId: "session-a" },
        fromSeq: 2,
        throughSeq: 2,
      },
    });
    pair.advance(200);
    expect(pair.a.isEventPending("glitch-gap-retried")).toBe(false);

    pair.dropNextFromA();
    pair.a.sendCritical(
      "OVERSIZE_PIECE",
      { eventId: "oversize-after-gap", targetPlayerId: "player-b" },
      122,
    );
    const framesBeforeTimeout = pair.sentCounts().a;
    pair.advance(599);
    expect(pair.sentCounts().a).toBe(framesBeforeTimeout);

    pair.advance(1);
    expect(pair.sentCounts().a).toBe(framesBeforeTimeout + 1);
  });

  it("bounds simultaneously due retransmissions per pump", () => {
    const clock = new ManualClock();
    const sent: RealtimeEnvelope[] = [];
    const sender = new CriticalReliability({
      matchId: "match-1",
      identity: { senderId: "player-a", sessionId: "session-a" },
      peer: { senderId: "player-b", sessionId: "session-b" },
      clock,
      getMatchTick: () => 120,
      send: (envelope) => sent.push(envelope),
      apply: () => undefined,
    });
    for (let index = 1; index <= 64; index += 1) {
      sender.sendCritical(
        "HOLLOW_CROSS",
        { eventId: `cross-burst-${index}`, targetPlayerId: "player-b" },
        120,
      );
    }
    expect(sent).toHaveLength(64);

    clock.advance(1_000);
    sender.pump();
    expect(sent).toHaveLength(80);

    sender.pump();
    expect(sent).toHaveLength(96);
  });

  it("does not let an older retry batch starve later pending events", () => {
    const clock = new ManualClock();
    const sentEventIds: string[] = [];
    const sender = new CriticalReliability({
      matchId: "match-1",
      identity: { senderId: "player-a", sessionId: "session-a" },
      peer: { senderId: "player-b", sessionId: "session-b" },
      clock,
      getMatchTick: () => 120,
      send: (envelope) => {
        if (envelope.seq !== undefined) {
          sentEventIds.push(
            (envelope as RealtimeEnvelope<CriticalKind>).payload.eventId,
          );
        }
      },
      apply: () => undefined,
    });
    for (let index = 1; index <= 32; index += 1) {
      sender.sendCritical(
        "HOLLOW_CROSS",
        { eventId: `cross-fair-${index}`, targetPlayerId: "player-b" },
        120,
      );
    }

    clock.advance(1_000);
    sender.pump();
    expect(sentEventIds.slice(32)).toEqual(
      Array.from({ length: 16 }, (_, index) => `cross-fair-${index + 1}`),
    );

    clock.advance(2_000);
    sender.pump();
    expect(sentEventIds.slice(48)).toEqual(
      Array.from({ length: 16 }, (_, index) => `cross-fair-${index + 17}`),
    );
  });

  it("backs off black-holed traffic and caps its retry interval", () => {
    const clock = new ManualClock();
    let sent = 0;
    const sender = new CriticalReliability({
      matchId: "match-1",
      identity: { senderId: "player-a", sessionId: "session-a" },
      peer: { senderId: "player-b", sessionId: "session-b" },
      clock,
      getMatchTick: () => 120,
      send: () => {
        sent += 1;
      },
      apply: () => undefined,
    });
    sender.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-black-hole", targetPlayerId: "player-b" },
      120,
    );

    for (let elapsedMs = 0; elapsedMs < 60_000; elapsedMs += 100) {
      clock.advance(100);
      sender.pump();
    }

    // Initial send, then 1s, 3s, 7s, and an 8s-capped cadence through 55s.
    expect(sent).toBe(10);
    expect(sender.isEventPending("cross-black-hole")).toBe(true);
  });

  it("applies a duplicated critical event once and acknowledges its outbox entry", () => {
    const { bus, a, appliedB } = createPair();
    bus.duplicateNext("a", "b");

    a.sendCritical(
      "GARBAGE_ATTACK",
      { eventId: "attack-1", targetPlayerId: "player-b", rows: 2 },
      120,
    );

    expect(appliedB.map((frame) => frame.payload.eventId)).toEqual(["attack-1"]);
    expect(a.pendingCount).toBe(0);
  });

  it("buffers a sequence gap, requests the missing event, and drains in order", () => {
    const { bus, a, appliedB } = createPair();
    bus.delayNext("a", "b");

    a.sendCritical(
      "GARBAGE_ATTACK",
      { eventId: "attack-1", targetPlayerId: "player-b", rows: 1 },
      120,
    );
    a.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-2", targetPlayerId: "player-b" },
      121,
    );

    expect(appliedB.map((frame) => frame.payload.eventId)).toEqual([
      "attack-1",
      "cross-2",
    ]);
    expect(a.pendingCount).toBe(0);

    bus.releaseDelayed();
    expect(appliedB).toHaveLength(2);
  });

  it("bounds retries when a missing prefix leaves later events buffered", () => {
    const clock = new ManualClock();
    const streamA: StreamRef = { senderId: "player-a", sessionId: "session-a" };
    const streamB: StreamRef = { senderId: "player-b", sessionId: "session-b" };
    let sentByA = 0;
    let sentByB = 0;
    let a!: CriticalReliability;
    let b!: CriticalReliability;
    a = new CriticalReliability({
      matchId: "match-1",
      identity: streamA,
      peer: streamB,
      clock,
      getMatchTick: () => 120,
      send: (frame) => {
        sentByA += 1;
        if (frame.seq === 1) return;
        b.receive(frame);
      },
      apply: () => undefined,
    });
    b = new CriticalReliability({
      matchId: "match-1",
      identity: streamB,
      peer: streamA,
      clock,
      getMatchTick: () => 120,
      send: (frame) => {
        sentByB += 1;
        a.receive(frame);
      },
      apply: () => undefined,
    });

    for (let index = 1; index <= 8; index += 1) {
      a.sendCritical(
        "HOLLOW_CROSS",
        { eventId: `event-${index}`, targetPlayerId: "player-b" },
        120 + index,
      );
    }
    const framesBeforeRetry = sentByA + sentByB;
    expect(framesBeforeRetry).toBe(10);

    clock.advance(999);
    a.pump();
    expect(sentByA + sentByB).toBe(framesBeforeRetry);

    clock.advance(1);
    a.pump();

    // Seven due future events, one rate-limited gap request, and one immediate
    // resend of the already-backed-off missing prefix. Buffered future events
    // must not recursively provoke overlapping requests and retransmissions.
    expect(sentByA + sentByB - framesBeforeRetry).toBe(9);
  });

  it("rate-limits differently anchored overlapping gap ranges from an older peer", () => {
    const clock = new ManualClock();
    const streamA: StreamRef = { senderId: "player-a", sessionId: "session-a" };
    const streamB: StreamRef = { senderId: "player-b", sessionId: "session-b" };
    const sent: RealtimeEnvelope[] = [];
    const a = new CriticalReliability({
      matchId: "match-1",
      identity: streamA,
      peer: streamB,
      clock,
      getMatchTick: () => 120,
      send: (frame) => sent.push(frame),
      apply: () => undefined,
    });
    for (let index = 1; index <= 8; index += 1) {
      a.sendCritical(
        "HOLLOW_CROSS",
        { eventId: `event-${index}`, targetPlayerId: "player-b" },
        120 + index,
      );
    }
    const framesBeforeGapRequests = sent.length;

    for (const [fromSeq, throughSeq] of [[1, 4], [2, 5], [4, 8]] as const) {
      a.receive({
        protocol: 1,
        matchId: "match-1",
        senderId: streamB.senderId,
        sessionId: streamB.sessionId,
        kind: "GAP_REQUEST",
        matchTick: 120,
        sentAtMonotonicMs: clock.now(),
        payload: { stream: streamA, fromSeq, throughSeq },
      });
    }

    expect(sent.length - framesBeforeGapRequests).toBe(4);
  });

  it("shares the bounded resend budget with large gap requests", () => {
    const clock = new ManualClock();
    const streamA: StreamRef = { senderId: "player-a", sessionId: "session-a" };
    const streamB: StreamRef = { senderId: "player-b", sessionId: "session-b" };
    const sent: RealtimeEnvelope[] = [];
    const sender = new CriticalReliability({
      matchId: "match-1",
      identity: streamA,
      peer: streamB,
      clock,
      getMatchTick: () => 120,
      send: (frame) => sent.push(frame),
      apply: () => undefined,
    });
    for (let index = 1; index <= 64; index += 1) {
      sender.sendCritical(
        "HOLLOW_CROSS",
        { eventId: `gap-budget-${index}`, targetPlayerId: "player-b" },
        120,
      );
    }
    const requestGap = (fromSeq: number): void => sender.receive({
      protocol: 1,
      matchId: "match-1",
      senderId: streamB.senderId,
      sessionId: streamB.sessionId,
      kind: "GAP_REQUEST",
      matchTick: 120,
      sentAtMonotonicMs: clock.now(),
      payload: { stream: streamA, fromSeq, throughSeq: 64 },
    });
    const initialFrames = sent.length;

    requestGap(1);
    expect(sent.length - initialFrames).toBe(16);
    requestGap(17);
    expect(sent.length - initialFrames).toBe(16);

    sender.pump();
    requestGap(17);
    expect(sent.length - initialFrames).toBe(32);
  });

  it("retries an unacknowledged event after the conservative initial timeout", () => {
    const { clock, bus, a, appliedB } = createPair();
    bus.dropNext("a", "b");
    a.sendCritical(
      "GLITCH_PIECE",
      { eventId: "glitch-1", targetPlayerId: "player-b" },
      120,
    );

    clock.advance(999);
    a.pump();
    expect(appliedB).toHaveLength(0);
    expect(a.pendingCount).toBe(1);

    clock.advance(1);
    a.pump();
    expect(appliedB.map((frame) => frame.payload.eventId)).toEqual(["glitch-1"]);
    expect(a.pendingCount).toBe(0);
  });

  it("ignores acknowledgements and keepalives from a spectator session", () => {
    const { a, bus } = createPair();
    a.setConnected(false);
    bus.dropNext("a", "b");
    const spectatorAck: RealtimeEnvelope<"ACK"> = {
      protocol: 1,
      matchId: "match-1",
      senderId: "spectator",
      sessionId: "spectator-session",
      kind: "ACK",
      matchTick: 120,
      sentAtMonotonicMs: 0,
      payload: {
        stream: { senderId: "player-a", sessionId: "session-a" },
        seqs: [1],
      },
    };
    a.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-1", targetPlayerId: "player-b" },
      120,
    );

    a.receive(spectatorAck);

    expect(a.pendingCount).toBe(1);
  });

  it("deduplicates a semantic event even when it arrives under a later sequence", () => {
    const { a, appliedB } = createPair();
    a.sendCritical(
      "GARBAGE_ATTACK",
      { eventId: "attack-stable", targetPlayerId: "player-b", rows: 1 },
      120,
    );
    a.sendCritical(
      "GARBAGE_ATTACK",
      { eventId: "attack-stable", targetPlayerId: "player-b", rows: 1 },
      120,
    );

    expect(appliedB).toHaveLength(1);
    expect(a.pendingCount).toBe(0);
  });

  it("uses a snapshot critical cursor to discard obsolete outbox events", () => {
    const { a, bus } = createPair();
    a.setConnected(false);
    bus.dropNext("a", "b", 2);
    a.sendCritical(
      "GARBAGE_ATTACK",
      { eventId: "attack-1", targetPlayerId: "player-b", rows: 1 },
      120,
    );
    a.sendCritical(
      "HOLLOW_CROSS",
      { eventId: "cross-2", targetPlayerId: "player-b" },
      121,
    );

    a.acknowledgeCursor({
      stream: { senderId: "player-a", sessionId: "session-a" },
      contiguousThrough: 1,
    });

    expect(a.pendingCount).toBe(1);
    expect(a.pendingEnvelopes().map((frame) => frame.seq)).toEqual([2]);
  });

  it("ignores an untrusted sequence beyond the bounded gap window", () => {
    const { b, appliedB } = createPair();
    const farAhead: RealtimeEnvelope<"GARBAGE_ATTACK"> = {
      protocol: 1,
      matchId: "match-1",
      senderId: "player-a",
      sessionId: "session-a",
      kind: "GARBAGE_ATTACK",
      seq: 258,
      matchTick: 120,
      sentAtMonotonicMs: 0,
      payload: { eventId: "far-ahead", targetPlayerId: "player-b", rows: 1 },
    };

    expect(() => b.receive(farAhead)).not.toThrow();
    expect(appliedB).toEqual([]);
  });

  it("commits the receive cursor before re-entrant application sends the next event", () => {
    const pair = createPair((frame, sender) => {
      if (frame.payload.eventId !== "attack-1") return;
      sender.sendCritical(
        "HOLLOW_CROSS",
        { eventId: "cross-2", targetPlayerId: "player-b" },
        121,
      );
    });

    pair.a.sendCritical(
      "GARBAGE_ATTACK",
      { eventId: "attack-1", targetPlayerId: "player-b", rows: 1 },
      120,
    );

    expect(pair.appliedB.map((frame) => frame.payload.eventId)).toEqual([
      "attack-1",
      "cross-2",
    ]);
    expect(pair.a.pendingCount).toBe(0);
  });
});

describe("peer liveness", () => {
  it("treats any authenticated frame from the bound opponent as proof of life", () => {
    const clock = new ManualClock();
    const liveness = new PeerLiveness({
      clock,
      peer: { senderId: "player-b", sessionId: "session-b" },
    });
    const ready: RealtimeEnvelope<"READY"> = {
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "READY",
      matchTick: 0,
      sentAtMonotonicMs: 2_999,
      payload: { ready: true, rulesHash: "rules-v1-hash" },
    };

    clock.advance(2_999);
    expect(liveness.observe(ready)).toBe(true);
    clock.advance(2_999);

    expect(liveness.isMissing()).toBe(false);
  });

  it("distinguishes a three-second warning from a five-second missing peer", () => {
    const clock = new ManualClock();
    const liveness = new PeerLiveness({
      clock,
      peer: { senderId: "player-b", sessionId: "session-b" },
    });
    const spectatorKeepalive: RealtimeEnvelope<"KEEPALIVE"> = {
      protocol: 1,
      matchId: "match-1",
      senderId: "spectator",
      sessionId: "spectator-session",
      kind: "KEEPALIVE",
      matchTick: 0,
      sentAtMonotonicMs: 2_999,
      payload: {
        activeSessionId: "spectator-session",
        resumeAvailable: true,
        lastSnapshotSeq: 0,
        inboundCritical: [],
      },
    };

    clock.advance(2_999);
    liveness.observe(spectatorKeepalive);
    expect(liveness.isMissing()).toBe(false);
    clock.advance(1);
    expect(liveness.isUnstable()).toBe(true);
    expect(liveness.isMissing()).toBe(false);
    clock.advance(2_000);
    expect(liveness.isMissing()).toBe(true);
  });
});
