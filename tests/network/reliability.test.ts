import { describe, expect, it } from "vitest";

import { decodeEnvelope, encodeEnvelope } from "../../src/network/codec";
import { InMemoryRealtimeBus, ManualClock } from "../../src/network/in-memory";
import { CriticalReliability, PeerLiveness } from "../../src/network/reliability";
import type {
  CriticalKind,
  RealtimeEnvelope,
  StreamRef,
} from "../../src/network/messages";

function createPair(
  onApplyB?: (
    frame: RealtimeEnvelope<CriticalKind>,
    sender: CriticalReliability,
  ) => void,
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
    apply: (frame) => appliedA.push(frame),
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
      onApplyB?.(frame, a);
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

describe("critical realtime reliability", () => {
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

    clock.advance(250);
    a.pump();

    // One regular resend per pending event, one gap request, and one immediate
    // resend of the missing prefix. Buffered future events must not recursively
    // provoke overlapping gap requests and retransmissions.
    expect(sentByA + sentByB - framesBeforeRetry).toBe(10);
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

  it("retries an unacknowledged event after 250 ms while connected", () => {
    const { clock, bus, a, appliedB } = createPair();
    bus.dropNext("a", "b");
    a.sendCritical(
      "GLITCH_PIECE",
      { eventId: "glitch-1", targetPlayerId: "player-b" },
      120,
    );

    clock.advance(249);
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
