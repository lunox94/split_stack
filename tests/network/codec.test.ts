import { describe, expect, it } from "vitest";

import { decodeEnvelope, encodeEnvelope } from "../../src/network/codec";
import type { RealtimeEnvelope } from "../../src/network/messages";

const keepalive: RealtimeEnvelope<"KEEPALIVE"> = {
  protocol: 1,
  matchId: "match-1",
  senderId: "player-a",
  sessionId: "session-a",
  kind: "KEEPALIVE",
  matchTick: 120,
  sentAtMonotonicMs: 2_000,
  payload: {
    activeSessionId: "session-a",
    resumeAvailable: true,
    lastSnapshotSeq: 20,
    inboundCritical: [],
  },
};

describe("realtime envelope codec", () => {
  it("round-trips a bounded UTF-8 JSON envelope", () => {
    const decoded = decodeEnvelope(encodeEnvelope(keepalive), {
      expectedMatchId: "match-1",
      allowedSenderIds: new Set(["player-a"]),
    });

    expect(decoded).toEqual({ ok: true, value: keepalive });
  });

  it("rejects invalid UTF-8 and unknown message kinds without throwing", () => {
    expect(decodeEnvelope(new Uint8Array([0xc3, 0x28]))).toMatchObject({
      ok: false,
      error: "invalid-utf8",
    });

    const unknown = new TextEncoder().encode(
      JSON.stringify({ ...keepalive, kind: "EXPLODE_EVERYTHING" }),
    );
    expect(decodeEnvelope(unknown)).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
  });

  it("requires a sequence and semantic event ID for critical messages", () => {
    const invalid = {
      ...keepalive,
      kind: "GARBAGE_ATTACK",
      payload: { targetPlayerId: "player-b", rows: 2 },
    };

    expect(decodeEnvelope(new TextEncoder().encode(JSON.stringify(invalid)))).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
  });

  it("validates payload field types and kind-specific queue bounds", () => {
    const invalidAttack = {
      ...keepalive,
      kind: "GARBAGE_ATTACK",
      seq: 1,
      payload: { eventId: "attack-1", targetPlayerId: "player-b", rows: "two" },
    };
    expect(
      decodeEnvelope(new TextEncoder().encode(JSON.stringify(invalidAttack))),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });

    const oversizedAck = {
      ...keepalive,
      kind: "ACK",
      payload: {
        stream: { senderId: "player-b", sessionId: "session-b" },
        seqs: Array.from({ length: 257 }, (_, index) => index + 1),
      },
    };
    expect(
      decodeEnvelope(new TextEncoder().encode(JSON.stringify(oversizedAck))),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });
  });

  it("accepts bounded Oversize and Ghost Jam attack messages", () => {
    for (const [kind, eventId] of [
      ["OVERSIZE_PIECE", "oversize-1"],
      ["GHOST_JAM_START", "ghost-jam-1"],
    ] as const) {
      const attack = {
        ...keepalive,
        kind,
        seq: 1,
        payload: {
          eventId,
          targetPlayerId: "player-b",
        },
      };

      expect(
        decodeEnvelope(new TextEncoder().encode(JSON.stringify(attack))),
      ).toMatchObject({ ok: true });
    }
  });

  it("accepts the complete unsigned 32-bit state-hash range", () => {
    const topOut = {
      ...keepalive,
      kind: "TOP_OUT",
      seq: 1,
      payload: {
        eventId: "top-out-1",
        playerId: "player-a",
        reason: "spawn-collision",
        stateHash: 0xffff_ffff,
        finalLevel: 1,
        finalStats: {
          score: 100,
          lines: 1,
          garbageSent: 0,
          powersActivated: 0,
          tetrises: 0,
          tSpinSingles: 0,
          tSpinDoubles: 0,
          tSpinTriples: 0,
          topOutTick: 120,
        },
      },
    };

    expect(
      decodeEnvelope(new TextEncoder().encode(JSON.stringify(topOut))),
    ).toMatchObject({ ok: true });
  });

  it("requires signed event identities and a complete coordinator config", () => {
    const forgedTopOut = {
      ...keepalive,
      kind: "TOP_OUT",
      seq: 1,
      payload: {
        eventId: "top-out-1",
        playerId: "player-b",
        reason: "spawn-collision",
        stateHash: 1,
        finalLevel: 1,
        finalStats: {
          score: 0,
          lines: 0,
          garbageSent: 0,
          powersActivated: 0,
          tetrises: 0,
          tSpinSingles: 0,
          tSpinDoubles: 0,
          tSpinTriples: 0,
          topOutTick: 120,
        },
      },
    };
    expect(
      decodeEnvelope(new TextEncoder().encode(JSON.stringify(forgedTopOut))),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });

    const incompleteForfeit = {
      ...keepalive,
      kind: "FORFEIT",
      seq: 1,
      payload: {
        eventId: "forfeit-1",
        forfeitingPlayerId: "player-a",
      },
    };
    expect(
      decodeEnvelope(new TextEncoder().encode(JSON.stringify(incompleteForfeit))),
    ).toMatchObject({ ok: false, error: "invalid-envelope" });

    const config: RealtimeEnvelope<"MATCH_CONFIG"> = {
      ...keepalive,
      kind: "MATCH_CONFIG",
      seq: 1,
      payload: {
        eventId: "config-1",
        rulesVersion: 2,
        rulesHash: "rules-hash",
        configHash: "config-hash",
        seed: "00112233445566778899aabbccddeeff",
        coordinatorPlayerId: "player-a",
        seatAPlayerId: "player-a",
        seatBPlayerId: "player-b",
      },
    };
    expect(decodeEnvelope(encodeEnvelope(config))).toMatchObject({ ok: true });
  });

  it("rejects cyclic objects on encoding without overflowing the stack", () => {
    const cyclic = { ...keepalive, payload: { ...keepalive.payload } } as unknown as Record<
      string,
      unknown
    >;
    (cyclic.payload as Record<string, unknown>).cycle = cyclic;

    expect(() => encodeEnvelope(cyclic as unknown as RealtimeEnvelope)).toThrow(
      /invalid realtime envelope/i,
    );
  });

  it("rejects malformed result players without throwing across the network boundary", () => {
    const malformedResult = {
      ...keepalive,
      kind: "RESULT_CONFIRM",
      seq: 1,
      payload: {
        eventId: "result-1",
        resultHash: "hash-1",
        result: {
          schema: "split-stack/result/v1",
          matchId: "match-1",
          seedHash: "seed",
          players: [null, null],
          outcome: "draw",
          reason: "simultaneous",
          durationTicks: 0,
          finalLevel: 1,
          statsByPlayer: {},
          completedBy: "player-a",
        },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(malformedResult));

    expect(() => decodeEnvelope(bytes)).not.toThrow();
    expect(decodeEnvelope(bytes)).toMatchObject({
      ok: false,
      error: "invalid-envelope",
    });
  });

  it("rejects foreign matches, unseated senders, excessive depth, and oversized data", () => {
    const encoded = encodeEnvelope(keepalive);
    expect(
      decodeEnvelope(encoded, {
        expectedMatchId: "another-match",
        allowedSenderIds: new Set(["player-a"]),
      }),
    ).toMatchObject({ ok: false, error: "foreign-match" });
    expect(
      decodeEnvelope(encoded, {
        expectedMatchId: "match-1",
        allowedSenderIds: new Set(["player-b"]),
      }),
    ).toMatchObject({ ok: false, error: "foreign-sender" });

    const tooDeep = JSON.parse(JSON.stringify(keepalive)) as Record<string, unknown>;
    let cursor: Record<string, unknown> = tooDeep;
    for (let index = 0; index < 9; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.nested = next;
      cursor = next;
    }
    expect(
      decodeEnvelope(new TextEncoder().encode(JSON.stringify(tooDeep))),
    ).toMatchObject({ ok: false, error: "too-deep" });

    expect(decodeEnvelope(new Uint8Array(128_001))).toMatchObject({
      ok: false,
      error: "too-large",
    });
  });
});
