import { describe, expect, it } from "vitest";

import {
  MAX_RETAINED_SESSION_CLAIMS,
  RuntimeSessionElection,
  isSessionClaim,
  type SessionClaimV1,
} from "../../src/app/runtime-election";

const scope = {
  challengeId: "challenge-1",
  occupancyEventId: "occupancy-alice",
  actorId: "alice@example.invalid",
} as const;

function claim(
  logicalClock: number,
  runtimeSessionId: string,
  eventId = `session-claim-${logicalClock}`,
  overrides: Partial<SessionClaimV1> = {},
): SessionClaimV1 {
  return {
    schema: "split-stack/session-claim/v1",
    kind: "session-claim",
    challengeId: scope.challengeId,
    occupancyEventId: scope.occupancyEventId,
    runtimeSessionId,
    eventId,
    logicalClock,
    actor: { id: scope.actorId, displayName: "Alice" },
    ...overrides,
  };
}

describe("session claim validation", () => {
  it("accepts only the exact bounded version-one payload shape", () => {
    const valid = claim(7, "runtime-random-7");
    expect(isSessionClaim(valid)).toBe(true);

    const invalid: unknown[] = [
      null,
      [],
      { ...valid, schema: "split-stack/session-claim/v2" },
      { ...valid, kind: "claim" },
      { ...valid, logicalClock: 0 },
      { ...valid, logicalClock: 1.5 },
      { ...valid, runtimeSessionId: "" },
      { ...valid, runtimeSessionId: "x".repeat(129) },
      { ...valid, eventId: "x".repeat(257) },
      { ...valid, extra: true },
      { ...valid, actor: { ...valid.actor, extra: true } },
      { ...valid, actor: { id: "", displayName: "Alice" } },
      { ...valid, actor: { id: valid.actor.id, displayName: "" } },
    ];

    for (const candidate of invalid) expect(isSessionClaim(candidate)).toBe(false);
  });
});

describe("runtime session election", () => {
  it("materializes the deterministic newest Lamport/event-ID winner out of order", () => {
    const election = new RuntimeSessionElection(scope);
    election.apply(claim(9, "runtime-lower-id", "event-a"));
    election.apply(claim(3, "runtime-old", "event-z"));
    election.apply(claim(9, "runtime-higher-event", "event-z"));

    expect(election.winner()).toMatchObject({
      logicalClock: 9,
      eventId: "event-z",
      runtimeSessionId: "runtime-higher-event",
    });
    expect(election.isWinningRuntime("runtime-higher-event")).toBe(true);
    expect(election.isWinningRuntime("runtime-old")).toBe(false);
  });

  it("does not replace the old runtime until the new durable claim is observed", () => {
    const election = new RuntimeSessionElection(scope);
    const oldClaim = claim(4, "runtime-old");
    const newClaim = claim(5, "runtime-new");

    election.apply(oldClaim);
    expect(election.isLocalClaimConfirmed(oldClaim)).toBe(true);
    expect(election.isLocalClaimConfirmed(newClaim)).toBe(false);
    expect(election.isWinningRuntime("runtime-old")).toBe(true);

    election.apply(newClaim);
    expect(election.isLocalClaimConfirmed(newClaim)).toBe(true);
    expect(election.isLocalClaimConfirmed(oldClaim)).toBe(false);
    expect(election.isWinningRuntime("runtime-new")).toBe(true);
  });

  it("ignores valid claims outside the occupied-seat and actor scope", () => {
    const election = new RuntimeSessionElection(scope);
    expect(
      election.apply(claim(1, "other-challenge", "other-c", { challengeId: "challenge-2" })),
    ).toBe(false);
    expect(
      election.apply(
        claim(2, "other-occupancy", "other-o", { occupancyEventId: "occupancy-bob" }),
      ),
    ).toBe(false);
    expect(
      election.apply(
        claim(3, "other-actor", "other-a", {
          actor: { id: "bob@example.invalid", displayName: "Bob" },
        }),
      ),
    ).toBe(false);
    expect(election.winner()).toBeUndefined();
    expect(election.retainedClaimCount).toBe(0);
  });

  it("deduplicates exact events and resolves conflicting event IDs independently of arrival order", () => {
    const lowerVariant = claim(11, "runtime-a", "duplicate-event");
    const higherVariant = claim(12, "runtime-b", "duplicate-event");
    const first = new RuntimeSessionElection(scope);
    const second = new RuntimeSessionElection(scope);

    expect(first.apply(lowerVariant)).toBe(true);
    expect(first.apply(lowerVariant)).toBe(false);
    first.apply(higherVariant);
    second.apply(higherVariant);
    second.apply(lowerVariant);

    expect(first.retainedClaimCount).toBe(1);
    expect(second.retainedClaimCount).toBe(1);
    expect(first.winner()).toEqual(second.winner());
    expect(first.winner()?.runtimeSessionId).toBe("runtime-b");
    expect(first.isLocalClaimConfirmed(lowerVariant)).toBe(false);
    expect(first.isLocalClaimConfirmed(higherVariant)).toBe(true);
  });

  it("clones accepted claims and returned winners across the mutable durable boundary", () => {
    const election = new RuntimeSessionElection(scope);
    const mutable = claim(1, "runtime-original") as {
      runtimeSessionId: string;
      actor: { displayName: string };
    } & SessionClaimV1;
    election.apply(mutable);
    mutable.runtimeSessionId = "runtime-mutated";
    mutable.actor.displayName = "Mallory";

    const returned = election.winner() as {
      runtimeSessionId: string;
      actor: { displayName: string };
    } & SessionClaimV1;
    expect(returned.runtimeSessionId).toBe("runtime-original");
    expect(returned.actor.displayName).toBe("Alice");
    returned.runtimeSessionId = "runtime-return-mutation";
    expect(election.winner()?.runtimeSessionId).toBe("runtime-original");
  });

  it("retains a bounded deterministic newest window regardless of arrival order", () => {
    const ascending = new RuntimeSessionElection(scope, { maxClaims: 3 });
    const descending = new RuntimeSessionElection(scope, { maxClaims: 3 });
    const claims = Array.from({ length: 10 }, (_, index) =>
      claim(index + 1, `runtime-${index + 1}`),
    );
    for (const candidate of claims) ascending.apply(candidate);
    for (const candidate of [...claims].reverse()) descending.apply(candidate);

    expect(ascending.retainedClaimCount).toBe(3);
    expect(descending.retainedClaimCount).toBe(3);
    expect(ascending.winner()).toEqual(descending.winner());
    expect(ascending.winner()?.runtimeSessionId).toBe("runtime-10");
    expect(ascending.isLocalClaimConfirmed(claims[0] as SessionClaimV1)).toBe(false);
    expect(ascending.apply(claim(1, "runtime-1"))).toBe(false);
  });

  it("rejects invalid scopes and capacities above the hard bound", () => {
    expect(() => new RuntimeSessionElection({ ...scope, actorId: "" })).toThrow(/scope/i);
    expect(() => new RuntimeSessionElection(scope, { maxClaims: 0 })).toThrow(/capacity/i);
    expect(
      () =>
        new RuntimeSessionElection(scope, {
          maxClaims: MAX_RETAINED_SESSION_CLAIMS + 1,
        }),
    ).toThrow(/capacity/i);
  });
});
