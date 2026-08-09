import { describe, expect, it } from "vitest";

import {
  COMPETITION_EVENT_SCHEMA,
  type CompetitionEvent,
} from "../../src/app/competition-ledger";
import { PendingChatFeedbackStore } from "../../src/app/pending-chat-feedback";
import type { StoragePort } from "../../src/persistence/settings";

class MemoryStorage implements StoragePort {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function challengeCreated(eventId = "create-1"): CompetitionEvent {
  return {
    schema: COMPETITION_EVENT_SCHEMA,
    kind: "challenge-created",
    eventId,
    logicalClock: 1,
    actor: { id: "alice@example.test", displayName: "Alice" },
    challengeId: "challenge-1",
    rulesHash: "rules-v2",
    vacancyId: "vacancy-1",
  };
}

function matchConceded(eventId = "concede-1"): CompetitionEvent {
  return {
    schema: COMPETITION_EVENT_SCHEMA,
    kind: "match-conceded",
    eventId,
    logicalClock: 8,
    actor: { id: "alice@example.test", displayName: "Alice" },
    matchId: "match-1",
    startedEventId: "start-1",
  };
}

describe("pending chat feedback recovery journal", () => {
  it("survives reload until a durable metadata receipt acknowledges it", () => {
    const storage = new MemoryStorage();
    const first = new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    );
    first.add(challengeCreated(), { kind: "challenge-created" });

    const afterRawAcceptance = new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    );
    expect(afterRawAcceptance.entries()).toMatchObject([{
      payload: { eventId: "create-1" },
      resolver: { kind: "challenge-created" },
      resolved: false,
    }]);

    afterRawAcceptance.resolve("create-1", {
      info: "Alice is waiting for an opponent.",
      href: "index.html#lobby/challenge/challenge-1",
      summary: "1 wait · 0 live",
    });
    const beforeMetadataReceipt = new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    );
    expect(beforeMetadataReceipt.entries()).toMatchObject([{
      resolved: true,
      metadata: { info: "Alice is waiting for an opponent." },
    }]);

    beforeMetadataReceipt.acknowledge("create-1");
    expect(new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    ).entries()).toEqual([]);
  });

  it("scopes recovery to the event actor and rules version", () => {
    const storage = new MemoryStorage();
    const alice = new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    );
    alice.add(challengeCreated(), { kind: "challenge-created" });

    expect(new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "bob@example.test",
    ).entries()).toEqual([]);
    expect(new PendingChatFeedbackStore(
      storage,
      "rules-v3",
      "alice@example.test",
    ).entries()).toEqual([]);
  });

  it("does not persist a resolver that does not match its event kind", () => {
    const storage = new MemoryStorage();
    const store = new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    );

    store.add(challengeCreated(), { kind: "match-result" });

    expect(store.entries()).toEqual([]);
  });

  it("keeps concession feedback pending until its result message is received", () => {
    const storage = new MemoryStorage();
    const first = new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    );

    first.add(matchConceded(), { kind: "match-result" });

    expect(new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    ).entries()).toMatchObject([{
      payload: { kind: "match-conceded", eventId: "concede-1" },
      resolver: { kind: "match-result" },
      resolved: false,
    }]);
  });

  it("reserves two recovery slots for terminal result feedback", () => {
    const storage = new MemoryStorage();
    const store = new PendingChatFeedbackStore(
      storage,
      "rules-v2",
      "alice@example.test",
    );

    for (let index = 0; index < 64; index += 1) {
      store.add(challengeCreated(`optional-${index}`), { kind: "challenge-created" });
    }
    store.add(matchConceded("terminal-1"), { kind: "match-result" });
    store.add(matchConceded("terminal-2"), { kind: "match-result" });

    expect(store.entries()).toHaveLength(64);
    expect(store.entries().filter((entry) => entry.resolver.kind === "challenge-created"))
      .toHaveLength(62);
    expect(store.entries().filter((entry) => entry.resolver.kind === "match-result"))
      .toMatchObject([
        { payload: { eventId: "terminal-1" } },
        { payload: { eventId: "terminal-2" } },
      ]);
  });
});
