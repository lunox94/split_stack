import { describe, expect, it } from "vitest";

import {
  WebxdcDurableLog,
  DurableLamportClock,
  MAX_DURABLE_LOGICAL_CLOCK,
  materializeChallenge,
  type LobbyEventV1,
} from "../../src/network/webxdc-durable";

describe("durable Webxdc listener", () => {
  it("registers the host listener exactly once and exposes replayed serials", async () => {
    let registrations = 0;
    const received: number[] = [];
    const host = {
      selfAddr: "player-a",
      selfName: "Alice",
      sendUpdate: () => undefined,
      setUpdateListener: (
        listener: (update: { payload: unknown; serial: number; max_serial: number }) => void,
        serial = 0,
      ) => {
        registrations += 1;
        expect(serial).toBe(0);
        listener({ payload: { kind: "fixture" }, serial: 4, max_serial: 4 });
        return Promise.resolve();
      },
    };
    const log = new WebxdcDurableLog(host);

    await log.start((update) => received.push(update.serial));

    expect(received).toEqual([4]);
    expect(registrations).toBe(1);
    await expect(log.start(() => undefined)).rejects.toThrow(/once/i);
    expect(registrations).toBe(1);
  });

  it("advances an application Lamport clock past observed durable events", () => {
    const clock = new DurableLamportClock();

    expect(clock.next()).toBe(1);
    clock.observe(7);
    expect(clock.next()).toBe(8);
    clock.observe(3);
    expect(clock.next()).toBe(9);
  });

  it("rejects hostile logical clocks that would exhaust local event creation", () => {
    const clock = new DurableLamportClock();
    expect(() => clock.observe(MAX_DURABLE_LOGICAL_CLOCK + 1)).toThrow(/range/i);
    clock.observe(MAX_DURABLE_LOGICAL_CLOCK);
    expect(() => clock.next()).toThrow(/exhausted/i);
  });

  it("rejects cyclic durable payloads at the adapter boundary", async () => {
    const host = {
      selfAddr: "player-a",
      selfName: "Alice",
      sendUpdate: () => undefined,
      setUpdateListener: () => undefined,
    };
    const log = new WebxdcDurableLog(host);
    const cyclic: { payload: Record<string, unknown> } = { payload: {} };
    cyclic.payload.self = cyclic;

    await expect(log.append(cyclic)).rejects.toThrow(/cyclic|serializable/i);
  });
});

describe("challenge and seat materialization", () => {
  it("assigns Seat A as coordinator and resolves concurrent Seat B claims by a convergent logical order", () => {
    const events: LobbyEventV1[] = [
      {
        schema: "split-stack/lobby/v1",
        kind: "seat-claimed",
        eventId: "claim-charlie",
        logicalClock: 2,
        challengeId: "challenge-1",
        vacancyId: "vacancy-1",
        actor: { id: "charlie", displayName: "Charlie" },
      },
      {
        schema: "split-stack/lobby/v1",
        kind: "challenge-created",
        eventId: "create-1",
        logicalClock: 1,
        challengeId: "challenge-1",
        seatBVacancyId: "vacancy-1",
        rulesHash: "rules-v1",
        actor: { id: "alice", displayName: "Alice" },
      },
      {
        schema: "split-stack/lobby/v1",
        kind: "seat-claimed",
        eventId: "claim-bob",
        logicalClock: 2,
        challengeId: "challenge-1",
        vacancyId: "vacancy-1",
        actor: { id: "bob", displayName: "Bob" },
      },
    ];

    const challenge = materializeChallenge(events, "challenge-1");

    expect(challenge).toMatchObject({
      coordinatorPlayerId: "alice",
      seatA: { playerId: "alice" },
      seatB: { playerId: "bob", occupancyEventId: "claim-bob" },
      closed: false,
    });
  });

  it("uses vacancy epochs so an old losing claim cannot inherit a released seat", () => {
    const events: LobbyEventV1[] = [
      {
        schema: "split-stack/lobby/v1",
        kind: "challenge-created",
        eventId: "create-1",
        logicalClock: 1,
        challengeId: "challenge-1",
        seatBVacancyId: "vacancy-1",
        rulesHash: "rules-v1",
        actor: { id: "alice", displayName: "Alice" },
      },
      {
        schema: "split-stack/lobby/v1",
        kind: "seat-claimed",
        eventId: "claim-bob",
        logicalClock: 2,
        challengeId: "challenge-1",
        vacancyId: "vacancy-1",
        actor: { id: "bob", displayName: "Bob" },
      },
      {
        schema: "split-stack/lobby/v1",
        kind: "seat-claimed",
        eventId: "stale-charlie",
        logicalClock: 3,
        challengeId: "challenge-1",
        vacancyId: "vacancy-1",
        actor: { id: "charlie", displayName: "Charlie" },
      },
      {
        schema: "split-stack/lobby/v1",
        kind: "seat-released",
        eventId: "release-bob",
        logicalClock: 4,
        challengeId: "challenge-1",
        actor: { id: "bob", displayName: "Bob" },
        occupancyEventId: "claim-bob",
        nextVacancyId: "vacancy-2",
      },
      {
        schema: "split-stack/lobby/v1",
        kind: "seat-claimed",
        eventId: "fresh-dana",
        logicalClock: 5,
        challengeId: "challenge-1",
        vacancyId: "vacancy-2",
        actor: { id: "dana", displayName: "Dana" },
      },
    ];

    expect(materializeChallenge(events, "challenge-1")?.seatB).toMatchObject({
      playerId: "dana",
      occupancyEventId: "fresh-dana",
    });
  });

  it("uses locale-independent code-unit ordering to break concurrent claim ties", () => {
    const created: LobbyEventV1 = {
      schema: "split-stack/lobby/v1",
      kind: "challenge-created",
      eventId: "create-1",
      logicalClock: 1,
      challengeId: "challenge-1",
      seatBVacancyId: "vacancy-1",
      rulesHash: "rules-v1",
      actor: { id: "alice", displayName: "Alice" },
    };
    const claim = (id: string): LobbyEventV1 => ({
      schema: "split-stack/lobby/v1",
      kind: "seat-claimed",
      eventId: `claim-${id}`,
      logicalClock: 2,
      challengeId: "challenge-1",
      vacancyId: "vacancy-1",
      actor: { id, displayName: id },
    });

    expect(
      materializeChallenge([created, claim("ä-player"), claim("z-player")], "challenge-1")
        ?.seatB?.playerId,
    ).toBe("z-player");
  });
});
