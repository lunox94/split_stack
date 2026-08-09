import { describe, expect, it } from "vitest";

import { RULES } from "../../src/config/rules";
import { hashCanonicalHex } from "../../src/domain/hashing";
import {
  createCompetitionEventLifecycle,
  type CompetitionIntent,
  type CompetitionLifecycleScheduler,
} from "../../src/app/competition-event-lifecycle";
import type {
  DurableOutboundUpdate,
  DurableReceivedUpdate,
  DurableWebxdcHost,
} from "../../src/network/webxdc-durable";
import type { StoragePort } from "../../src/persistence/settings";
import { PendingChatFeedbackStoreV2 } from "../../src/app/pending-chat-feedback";

class MemoryStorage implements StoragePort {
  public readonly writes: Array<{ key: string; value: string }> = [];
  private readonly values = new Map<string, string>();

  public constructor(
    private readonly rejectWrite: (key: string, value: string) => boolean = () => false,
  ) {}

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    if (this.rejectWrite(key, value)) throw new Error(`Storage rejected ${key}`);
    this.values.set(key, value);
    this.writes.push({ key, value });
  }

  public copy(): MemoryStorage {
    const copied = new MemoryStorage(this.rejectWrite);
    for (const [key, value] of this.values) copied.values.set(key, value);
    return copied;
  }
}

class ManualScheduler implements CompetitionLifecycleScheduler {
  private currentMs = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAtMs: number; task: () => void }>();

  public now(): number {
    return this.currentMs;
  }

  public setTimeout(task: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, {
      dueAtMs: this.currentMs + Math.max(0, delayMs),
      task,
    });
    return id;
  }

  public clearTimeout(id: number): void {
    this.tasks.delete(id);
  }

  public advanceBy(milliseconds: number): void {
    this.currentMs += milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAtMs <= this.currentMs)
        .sort((left, right) => left[1].dueAtMs - right[1].dueAtMs || left[0] - right[0])[0];
      if (next === undefined) return;
      this.tasks.delete(next[0]);
      next[1].task();
    }
  }
}

class InMemoryDurableWebxdc implements DurableWebxdcHost<unknown> {
  public readonly selfAddr: string;
  public readonly selfName: string;
  public readonly sent: DurableOutboundUpdate<unknown>[] = [];
  public readonly attempted: DurableOutboundUpdate<unknown>[] = [];
  public listenerRegistrations = 0;
  public listenerBarrier: Promise<void> | null = null;
  private listener: ((update: DurableReceivedUpdate<unknown>) => void) | null = null;
  private serial = 0;

  public constructor(
    actor: { readonly id: string; readonly displayName: string },
    private readonly beforeSend?: () => void,
  ) {
    this.selfAddr = actor.id;
    this.selfName = actor.displayName;
  }

  public sendUpdate(update: DurableOutboundUpdate<unknown>): void {
    this.attempted.push(structuredClone(update));
    this.beforeSend?.();
    this.sent.push(structuredClone(update));
  }

  public async setUpdateListener(
    listener: (update: DurableReceivedUpdate<unknown>) => void,
  ): Promise<void> {
    this.listenerRegistrations += 1;
    this.listener = listener;
    if (this.listenerBarrier !== null) await this.listenerBarrier;
  }

  public deliverSent(index: number): void {
    const update = this.sent[index];
    if (update === undefined) {
      throw new Error(`Cannot deliver durable send ${index}`);
    }
    this.deliver(update);
  }

  public deliver(update: DurableOutboundUpdate<unknown>): void {
    if (this.listener === null) throw new Error("Cannot deliver before listener registration");
    this.serial += 1;
    this.listener({
      ...structuredClone(update),
      serial: this.serial,
      max_serial: this.serial,
    });
  }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

interface PairedPlayerOptions {
  readonly aliceActor?: { readonly id: string; readonly displayName: string };
  readonly bobActor?: { readonly id: string; readonly displayName: string };
  readonly aliceCreateId?: () => string;
  readonly bobCreateId?: () => string;
}

async function createPairedPlayers(options: PairedPlayerOptions = {}) {
  const aliceActor = options.aliceActor ?? {
    id: "alice@example.test",
    displayName: "Alice",
  };
  const bobActor = options.bobActor ?? {
    id: "bob@example.test",
    displayName: "Bob",
  };
  const aliceHost = new InMemoryDurableWebxdc(aliceActor);
  const bobHost = new InMemoryDurableWebxdc(bobActor);
  const aliceScheduler = new ManualScheduler();
  const bobScheduler = new ManualScheduler();
  const aliceStorage = new MemoryStorage();
  const bobStorage = new MemoryStorage();
  let aliceId = 0;
  let bobId = 0;
  const alice = await createCompetitionEventLifecycle({
    actor: aliceActor,
    runtimeSessionId: "runtime-alice",
    currentRulesHash: "rules-current",
    host: aliceHost,
    storage: aliceStorage,
    scheduler: aliceScheduler,
    createId: options.aliceCreateId ?? (() => `alice-private-${aliceId += 1}`),
  });
  const bob = await createCompetitionEventLifecycle({
    actor: bobActor,
    runtimeSessionId: "runtime-bob",
    currentRulesHash: "rules-current",
    host: bobHost,
    storage: bobStorage,
    scheduler: bobScheduler,
    createId: options.bobCreateId ?? (() => `bob-private-${bobId += 1}`),
  });
  alice.express({ kind: "create-challenge" });
  await flushPromises();
  aliceHost.deliverSent(0);
  bobHost.deliver(aliceHost.sent[0]!);
  await flushPromises();
  const challengeId = bob.current().competition.openChallenges[0]!.challengeId;
  bob.express({ kind: "join-challenge", challengeId });
  await flushPromises();
  bobHost.deliverSent(0);
  aliceHost.deliver(bobHost.sent[0]!);
  await flushPromises();
  const pairingId = bob.current().competition.startingPairings[0]!.pairingId;
  const aliceRuntime = aliceHost.sent.find(
    (update) => (update.payload as { kind?: string }).kind === "runtime-claimed",
  )!;
  const bobRuntime = bobHost.sent.find(
    (update) => (update.payload as { kind?: string }).kind === "runtime-claimed",
  )!;
  aliceHost.deliver(aliceRuntime);
  bobHost.deliver(aliceRuntime);
  bobHost.deliver(bobRuntime);
  aliceHost.deliver(bobRuntime);
  await flushPromises();
  return {
    alice,
    aliceActor,
    aliceHost,
    aliceScheduler,
    aliceStorage,
    bob,
    bobActor,
    bobHost,
    bobScheduler,
    bobStorage,
    pairingId,
  };
}

async function createLiveMatch(options: PairedPlayerOptions = {}) {
  const paired = await createPairedPlayers(options);
  const { alice, aliceHost, bob, bobHost, pairingId } = paired;
  const aliceReady = alice.express({ kind: "set-readiness", pairingId, ready: true });
  const bobReady = bob.express({ kind: "set-readiness", pairingId, ready: true });
  await flushPromises();
  const aliceReadyUpdate = aliceHost.sent.find((update) =>
    (update.payload as { kind?: string }).kind === "ready-changed"
  )!;
  const bobReadyUpdate = bobHost.sent.find((update) =>
    (update.payload as { kind?: string }).kind === "ready-changed"
  )!;
  aliceHost.deliver(aliceReadyUpdate);
  bobHost.deliver(aliceReadyUpdate);
  bobHost.deliver(bobReadyUpdate);
  aliceHost.deliver(bobReadyUpdate);
  await flushPromises();
  expect(alice.current().intents.find((intent) => intent.reference === aliceReady)).toMatchObject({
    settled: true,
  });
  expect(bob.current().intents.find((intent) => intent.reference === bobReady)).toMatchObject({
    settled: true,
  });
  const seed = "00112233445566778899aabbccddeeff";
  const startReference = alice.express({ kind: "start-match", pairingId, seed });
  await flushPromises();
  const started = aliceHost.sent.find((update) =>
    (update.payload as { kind?: string }).kind === "match-started"
  )!;
  aliceHost.deliver(started);
  bobHost.deliver(started);
  await flushPromises();
  const startFeedback = aliceHost.sent.find((update) =>
    (update.payload as { eventId?: string }).eventId ===
      (started.payload as { eventId: string }).eventId &&
    update.info !== undefined
  )!;
  aliceHost.deliver(startFeedback);
  await flushPromises();
  expect(alice.current().intents.find((intent) => intent.reference === startReference)).toMatchObject({
    settled: true,
  });
  return {
    ...paired,
    matchId: alice.current().competition.liveMatches[0]!.matchId,
    seed,
    started,
  };
}

async function createCompletedMatch() {
  const live = await createLiveMatch();
  const { alice, aliceActor, aliceHost, bobActor, bobHost, matchId } = live;
  const stats = (score: number) => ({
    score,
    lines: 1,
    garbageSent: 0,
    powersActivated: 0,
    tetrises: 0,
    tSpinSingles: 0,
    tSpinDoubles: 0,
    tSpinTriples: 0,
  });
  const finishReference = alice.express({
    kind: "finish-match",
    matchId,
    result: {
      outcome: "seat-a",
      reason: "top-out",
      durationTicks: 600,
      finalLevel: 2,
      statsByPlayer: {
        [aliceActor.id]: stats(900),
        [bobActor.id]: stats(700),
      },
      completedBy: aliceActor.id,
    },
  });
  await flushPromises();
  const finished = aliceHost.sent[aliceHost.sent.length - 1]!;
  aliceHost.deliver(finished);
  bobHost.deliver(finished);
  await flushPromises();
  const resultFeedback = aliceHost.sent.find((update) =>
    (update.payload as { eventId?: string }).eventId ===
      (finished.payload as { eventId: string }).eventId &&
    update.info !== undefined
  )!;
  aliceHost.deliver(resultFeedback);
  await flushPromises();
  expect(alice.current().intents.find((intent) => intent.reference === finishReference)).toMatchObject({
    settled: true,
  });
  return live;
}

describe("Competition Event Lifecycle", () => {
  it.each([
    ["an empty actor id", { id: "", displayName: "Alice" }, "runtime-alice", /actor id/iu],
    [
      "an oversized actor id",
      { id: "a".repeat(257), displayName: "Alice" },
      "runtime-alice",
      /actor id/iu,
    ],
    [
      "an empty actor name",
      { id: "alice@example.test", displayName: "" },
      "runtime-alice",
      /actor display name/iu,
    ],
    [
      "an oversized actor name",
      { id: "alice@example.test", displayName: "a".repeat(129) },
      "runtime-alice",
      /actor display name/iu,
    ],
    [
      "an actor with extra properties",
      { id: "alice@example.test", displayName: "Alice", role: "admin" },
      "runtime-alice",
      /actor.*properties/iu,
    ],
    [
      "an empty runtime session id",
      { id: "alice@example.test", displayName: "Alice" },
      "",
      /runtime session id/iu,
    ],
    [
      "an oversized runtime session id",
      { id: "alice@example.test", displayName: "Alice" },
      "r".repeat(129),
      /runtime session id/iu,
    ],
  ])(
    "rejects %s at the constructor boundary",
    async (_label, actor, runtimeSessionId, error) => {
      const storage = new MemoryStorage();
      let createdIds = 0;

      await expect(createCompetitionEventLifecycle({
        actor,
        runtimeSessionId,
        currentRulesHash: "rules-current",
        host: null,
        storage,
        scheduler: new ManualScheduler(),
        createId: () => `unused-${createdIds += 1}`,
      })).rejects.toThrow(error);
      expect(storage.writes).toEqual([]);
      expect(createdIds).toBe(0);
    },
  );

  it("does not journal Practice intents when no durable host exists", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    let createdIds = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-standalone",
      currentRulesHash: "rules-current",
      host: null,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `unused-${createdIds += 1}`,
    });
    const completion: CompetitionIntent = {
      kind: "complete-practice",
      runId: "standalone-run",
      durationTicks: 600,
      finalLevel: 1,
      finalStats: {
        score: 500,
        lines: 1,
        garbageSent: 0,
        powersActivated: 0,
        tetrises: 0,
        tSpinSingles: 0,
        tSpinDoubles: 0,
        tSpinTriples: 0,
      },
    };

    expect(() => lifecycle.express(completion)).toThrow(/durable host/iu);
    expect(() => lifecycle.express(completion)).toThrow(/durable host/iu);
    expect(lifecycle.current().intents).toEqual([]);
    expect(storage.writes).toEqual([]);
    expect(createdIds).toBe(0);

    const reloaded = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-standalone-reloaded",
      currentRulesHash: "rules-current",
      host: null,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => "unused-on-reload",
    });
    expect(reloaded.current().intents).toEqual([]);
  });

  it("adopts and reuses a legacy terminal feedback journal identity", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const payload = {
      schema: "split-stack/competition/v2" as const,
      kind: "match-conceded" as const,
      eventId: "legacy-terminal-event",
      logicalClock: 7,
      actor,
      matchId: "legacy-match",
      startedEventId: "legacy-start",
    };
    new PendingChatFeedbackStoreV2(
      storage,
      "rules-current",
      actor.id,
    ).add(payload, { kind: "match-result" });
    const firstHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const first = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-upgrade",
      currentRulesHash: "rules-current",
      host: firstHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `recovered-reference-${nextId += 1}`,
    });
    await flushPromises();

    expect(first.current().intents).toMatchObject([{
      reference: expect.not.stringMatching(payload.eventId),
      intent: { kind: "concede-match", matchId: payload.matchId },
      eventStatus: "unconfirmed",
      feedbackStatus: "pending",
      settled: false,
    }]);
    expect(firstHost.sent).toEqual([{ payload }]);
    const reference = first.current().intents[0]!.reference;

    const reloadedHost = new InMemoryDurableWebxdc(actor);
    const reloaded = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-upgrade-reloaded",
      currentRulesHash: "rules-current",
      host: reloadedHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => {
        throw new Error("Legacy adoption must persist its opaque reference");
      },
    });
    await flushPromises();

    expect(reloaded.current().intents[0]?.reference).toBe(reference);
    expect(reloadedHost.sent).toEqual([{ payload }]);
  });

  it("does not duplicate legacy metadata that replay already confirms", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const payload = {
      schema: "split-stack/competition/v2" as const,
      kind: "match-conceded" as const,
      eventId: "legacy-confirmed-terminal",
      logicalClock: 7,
      actor,
      matchId: "legacy-confirmed-match",
      startedEventId: "legacy-confirmed-start",
    };
    const metadata = {
      summary: "0 wait · 0 live",
      info: "Alice conceded · opponent wins",
    };
    const journal = new PendingChatFeedbackStoreV2(
      storage,
      "rules-current",
      actor.id,
    );
    journal.add(payload, { kind: "match-result" });
    journal.resolve(payload.eventId, metadata);
    const host = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    host.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-upgrade",
      currentRulesHash: "rules-current",
      host,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => "legacy-confirmed-reference",
    });
    await flushPromises();
    host.deliver({ payload });
    host.deliver({ payload, ...metadata });
    releaseReplay();
    const lifecycle = await initializing;
    await flushPromises();

    expect(lifecycle.current().intents).toMatchObject([{
      intent: { kind: "concede-match", matchId: payload.matchId },
      feedbackStatus: "confirmed",
    }]);
    expect(host.sent).toEqual([]);
    expect(new PendingChatFeedbackStoreV2(
      storage,
      "rules-current",
      actor.id,
    ).entries()).toEqual([]);
  });

  it("does not adopt feedback as legacy when the current intent store is malformed", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    storage.setItem(
      "split-stack/competition-intents/v1:rules-current:alice@example.test",
      "malformed-current-store",
    );
    const payload = {
      schema: "split-stack/competition/v2" as const,
      kind: "practice-completed" as const,
      eventId: "current-store-journal-event",
      logicalClock: 7,
      actor,
      rulesHash: "rules-current",
      runId: "current-store-journal-run",
      endReason: "top-out" as const,
      score: 100,
      durationTicks: 60,
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
        topOutTick: 60,
      },
    };
    new PendingChatFeedbackStoreV2(
      storage,
      "rules-current",
      actor.id,
    ).add(payload, { kind: "practice-record" });
    const host = new InMemoryDurableWebxdc(actor);
    let allocations = 0;

    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-upgrade",
      currentRulesHash: "rules-current",
      host,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `unexpected-legacy-reference-${allocations += 1}`,
    });
    await flushPromises();

    expect(lifecycle.current().intents).toEqual([]);
    expect(host.sent).toEqual([]);
    expect(allocations).toBe(0);
  });

  it("does not expose a usable module until durable replay completes", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    host.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let initialized = false;
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => "private-id",
    }).then((lifecycle) => {
      initialized = true;
      return lifecycle;
    });

    await flushPromises();

    expect(host.listenerRegistrations).toBe(1);
    expect(initialized).toBe(false);

    releaseReplay();
    const lifecycle = await initializing;

    expect(lifecycle.current()).toMatchObject({
      revision: 0,
      competition: { openChallenges: [] },
    });
  });

  it("treats the listener echo as authority and chat feedback as part of settlement", async () => {
    const storage = new MemoryStorage();
    const scheduler = new ManualScheduler();
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor, () => {
      expect(storage.writes.length).toBeGreaterThan(0);
    });
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage,
      scheduler,
      createId: () => `private-${nextId += 1}`,
    });

    const reference = lifecycle.express({ kind: "create-challenge" });
    await flushPromises();

    expect(String(reference)).not.toContain("challenge-created");
    expect(host.listenerRegistrations).toBe(1);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]).toMatchObject({
      payload: {
        kind: "challenge-created",
        actor,
        rulesHash: "rules-current",
      },
    });
    expect(lifecycle.current().competition.openChallenges).toEqual([]);
    expect(lifecycle.current().intents).toMatchObject([{
      reference,
      eventStatus: "unconfirmed",
      feedbackStatus: "pending",
      settled: false,
    }]);

    host.deliverSent(0);
    await flushPromises();

    const accepted = lifecycle.current();
    expect(accepted.competition.openChallenges).toMatchObject([{
      creator: actor,
      rulesHash: "rules-current",
    }]);
    expect(accepted.intents).toMatchObject([{
      reference,
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    }]);
    expect(host.sent[1]).toMatchObject({
      payload: host.sent[0]?.payload,
      info: "Alice is waiting for an opponent.",
      summary: "1 wait · 0 live",
    });

    host.deliverSent(1);
    await flushPromises();

    expect(lifecycle.current().intents).toMatchObject([{
      reference,
      eventStatus: "effective",
      feedbackStatus: "confirmed",
      settled: true,
    }]);
  });

  it("rejects colliding private identities before persistence or send", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const host = new InMemoryDurableWebxdc(actor);
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => "one-colliding-private-id",
    });
    const writesBeforeAdmission = storage.writes.length;

    expect(() => lifecycle.express({ kind: "create-challenge" })).toThrow(
      "Competition Intent Reference must be unique",
    );
    await flushPromises();

    expect(host.attempted).toEqual([]);
    expect(storage.writes).toHaveLength(writesBeforeAdmission);
    expect(lifecycle.current().intents).toEqual([]);
  });

  it("joins an explicit challenge and derives the current vacancy inside the module", async () => {
    const aliceActor = { id: "alice@example.test", displayName: "Alice" };
    const bobActor = { id: "bob@example.test", displayName: "Bob" };
    const aliceHost = new InMemoryDurableWebxdc(aliceActor);
    const bobHost = new InMemoryDurableWebxdc(bobActor);
    const aliceScheduler = new ManualScheduler();
    const bobScheduler = new ManualScheduler();
    let aliceId = 0;
    let bobId = 0;
    const alice = await createCompetitionEventLifecycle({
      actor: aliceActor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host: aliceHost,
      storage: new MemoryStorage(),
      scheduler: aliceScheduler,
      createId: () => `alice-private-${aliceId += 1}`,
    });
    const bob = await createCompetitionEventLifecycle({
      actor: bobActor,
      runtimeSessionId: "runtime-bob",
      currentRulesHash: "rules-current",
      host: bobHost,
      storage: new MemoryStorage(),
      scheduler: bobScheduler,
      createId: () => `bob-private-${bobId += 1}`,
    });

    alice.express({ kind: "create-challenge" });
    await flushPromises();
    aliceHost.deliverSent(0);
    bobHost.deliver(aliceHost.sent[0]!);
    await flushPromises();
    const challenge = bob.current().competition.openChallenges[0];
    expect(challenge).toBeDefined();

    const reference = bob.express({
      kind: "join-challenge",
      challengeId: challenge!.challengeId,
    });
    await flushPromises();

    expect(bobHost.sent[0]).toMatchObject({
      payload: {
        kind: "challenge-claimed",
        challengeId: challenge!.challengeId,
        vacancyId: challenge!.vacancyId,
        actor: bobActor,
      },
    });
    bobHost.deliverSent(0);
    aliceHost.deliver(bobHost.sent[0]!);
    await flushPromises();

    expect(bob.current().competition.activity).toMatchObject({
      kind: "starting",
      pairingId: bobHost.sent[0]!.payload &&
        (bobHost.sent[0]!.payload as { eventId: string }).eventId,
    });
    expect(bob.current().intents).toMatchObject([{
      reference,
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    }]);
    expect(bobHost.sent[1]).toMatchObject({
      href: expect.stringContaining(encodeURIComponent(challenge!.challengeId)),
      notify: { [aliceActor.id]: "Bob joined your challenge" },
    });

    bobHost.deliverSent(1);
    await flushPromises();

    expect(bob.current().intents).toMatchObject([{
      reference,
      eventStatus: "effective",
      feedbackStatus: "confirmed",
      settled: true,
    }]);
  });

  it("cancels an explicit owned challenge through the same lifecycle", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    lifecycle.express({ kind: "create-challenge" });
    await flushPromises();
    host.deliverSent(0);
    await flushPromises();
    host.deliverSent(1);
    await flushPromises();
    const challengeId = lifecycle.current().competition.openChallenges[0]!.challengeId;

    const reference = lifecycle.express({ kind: "cancel-challenge", challengeId });
    await flushPromises();

    expect(host.sent[2]).toMatchObject({
      payload: {
        kind: "challenge-cancelled",
        challengeId,
        actor,
      },
    });
    host.deliverSent(2);
    await flushPromises();

    expect(lifecycle.current().competition.openChallenges).toEqual([]);
    expect(lifecycle.current().intents).toMatchObject([
      { settled: true },
      {
        reference,
        eventStatus: "effective",
        feedbackStatus: "pending",
        settled: false,
      },
    ]);
    expect(host.sent[3]).toMatchObject({
      payload: host.sent[2]!.payload,
      summary: "0 wait · 0 live",
    });

    host.deliverSent(3);
    await flushPromises();

    expect(lifecycle.current().intents[1]).toMatchObject({
      reference,
      eventStatus: "effective",
      feedbackStatus: "confirmed",
      settled: true,
    });
  });

  it("derives runtime claims after pairing and waits for their listener echoes", async () => {
    const aliceActor = { id: "alice@example.test", displayName: "Alice" };
    const bobActor = { id: "bob@example.test", displayName: "Bob" };
    const aliceHost = new InMemoryDurableWebxdc(aliceActor);
    const bobHost = new InMemoryDurableWebxdc(bobActor);
    const aliceScheduler = new ManualScheduler();
    const bobScheduler = new ManualScheduler();
    let aliceId = 0;
    let bobId = 0;
    const alice = await createCompetitionEventLifecycle({
      actor: aliceActor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host: aliceHost,
      storage: new MemoryStorage(),
      scheduler: aliceScheduler,
      createId: () => `alice-private-${aliceId += 1}`,
    });
    const bob = await createCompetitionEventLifecycle({
      actor: bobActor,
      runtimeSessionId: "runtime-bob",
      currentRulesHash: "rules-current",
      host: bobHost,
      storage: new MemoryStorage(),
      scheduler: bobScheduler,
      createId: () => `bob-private-${bobId += 1}`,
    });
    alice.express({ kind: "create-challenge" });
    await flushPromises();
    aliceHost.deliverSent(0);
    bobHost.deliver(aliceHost.sent[0]!);
    await flushPromises();
    const challengeId = bob.current().competition.openChallenges[0]!.challengeId;
    bob.express({ kind: "join-challenge", challengeId });
    await flushPromises();
    bobHost.deliverSent(0);
    aliceHost.deliver(bobHost.sent[0]!);
    await flushPromises();
    const pairingId = bob.current().competition.startingPairings[0]!.pairingId;

    const aliceRuntime = aliceHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "runtime-claimed"
    )!;
    const bobRuntime = bobHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "runtime-claimed"
    )!;
    expect(aliceRuntime).toMatchObject({
      payload: {
        kind: "runtime-claimed",
        pairingId,
        runtimeSessionId: "runtime-alice",
      },
    });
    expect(bobRuntime).toMatchObject({
      payload: {
        kind: "runtime-claimed",
        pairingId,
        runtimeSessionId: "runtime-bob",
      },
    });
    expect(
      alice.current().competition.startingPairings[0]!.runtimeSessionByPlayer,
    ).toEqual({});
    expect(
      bob.current().competition.startingPairings[0]!.runtimeSessionByPlayer,
    ).toEqual({});

    aliceHost.deliver(aliceRuntime);
    await flushPromises();
    aliceScheduler.advanceBy(1_000);
    await flushPromises();
    const aliceRuntimeSends = () => aliceHost.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId ===
        (aliceRuntime.payload as { eventId: string }).eventId
    );
    expect(aliceRuntimeSends()).toHaveLength(2);
    expect(aliceRuntimeSends()[1]!.payload).toEqual(aliceRuntime.payload);

    aliceHost.deliver(aliceRuntimeSends()[1]!);
    await flushPromises();
    aliceHost.deliver(bobRuntime);
    await flushPromises();
    expect(aliceRuntimeSends()).toHaveLength(3);
    expect(aliceRuntimeSends()[2]!.payload).toEqual(aliceRuntime.payload);

    bobHost.deliver(aliceRuntime);
    bobHost.deliver(bobRuntime);
    await flushPromises();

    expect(alice.current().competition.startingPairings[0]!.runtimeSessionByPlayer).toEqual({
      [aliceActor.id]: "runtime-alice",
      [bobActor.id]: "runtime-bob",
    });
    expect(bob.current().competition.startingPairings[0]!.runtimeSessionByPlayer).toEqual({
      [aliceActor.id]: "runtime-alice",
      [bobActor.id]: "runtime-bob",
    });
    expect(alice.current().intents).toHaveLength(1);
    expect(bob.current().intents).toHaveLength(1);
  });

  it("rejects invalid readiness input before it can enter recovery storage", async () => {
    const { alice, aliceHost, pairingId } = await createPairedPlayers();
    const beforeIntents = alice.current().intents.length;
    const beforeSends = aliceHost.sent.length;

    expect(() => alice.express({
      kind: "set-readiness",
      pairingId,
      ready: "yes",
    } as unknown as CompetitionIntent)).toThrow(/valid Competition Event/iu);

    expect(alice.current().intents).toHaveLength(beforeIntents);
    expect(aliceHost.sent).toHaveLength(beforeSends);
  });

  it("derives the current runtime session for an explicit readiness intent", async () => {
    const { aliceHost, bob, bobActor, bobHost, pairingId } = await createPairedPlayers();

    const reference = bob.express({
      kind: "set-readiness",
      pairingId,
      ready: true,
    });
    await flushPromises();
    const readiness = bobHost.sent[bobHost.sent.length - 1]!;

    expect(readiness).toMatchObject({
      payload: {
        kind: "ready-changed",
        pairingId,
        runtimeSessionId: "runtime-bob",
        ready: true,
      },
    });
    expect(bob.current().competition.startingPairings[0]!.readyByPlayer[bobActor.id]).toBe(false);

    bobHost.deliver(readiness);
    aliceHost.deliver(readiness);
    await flushPromises();

    expect(bob.current().competition.startingPairings[0]!.readyByPlayer[bobActor.id]).toBe(true);
    const intents = bob.current().intents;
    expect(intents[intents.length - 1]).toMatchObject({
      reference,
      eventStatus: "effective",
      feedbackStatus: "not-required",
      settled: true,
    });
  });

  it("leaves an explicit starting pairing with derived runtime and feedback", async () => {
    const { alice, aliceHost, bobHost, pairingId } = await createPairedPlayers();

    const reference = alice.express({ kind: "leave-pairing", pairingId });
    await flushPromises();
    const left = aliceHost.sent[aliceHost.sent.length - 1]!;

    expect(left).toMatchObject({
      payload: {
        kind: "pairing-left",
        pairingId,
        runtimeSessionId: "runtime-alice",
      },
    });
    aliceHost.deliver(left);
    bobHost.deliver(left);
    await flushPromises();

    expect(alice.current().competition.startingPairings).toEqual([]);
    expect(alice.current().competition.activity).toEqual({ kind: "idle" });
    expect(alice.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    });
    const metadata = aliceHost.sent[aliceHost.sent.length - 1]!;
    expect(metadata).toMatchObject({
      payload: left.payload,
      summary: "0 wait · 0 live",
    });

    aliceHost.deliver(metadata);
    await flushPromises();

    expect(alice.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      feedbackStatus: "confirmed",
      settled: true,
    });
  });

  it("admits a leave intent before its internal runtime claim is echoed", async () => {
    const aliceActor = { id: "alice@example.test", displayName: "Alice" };
    const bobActor = { id: "bob@example.test", displayName: "Bob" };
    const aliceHost = new InMemoryDurableWebxdc(aliceActor);
    const bobHost = new InMemoryDurableWebxdc(bobActor);
    let aliceId = 0;
    let bobId = 0;
    const alice = await createCompetitionEventLifecycle({
      actor: aliceActor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host: aliceHost,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `alice-private-${aliceId += 1}`,
    });
    const bob = await createCompetitionEventLifecycle({
      actor: bobActor,
      runtimeSessionId: "runtime-bob",
      currentRulesHash: "rules-current",
      host: bobHost,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `bob-private-${bobId += 1}`,
    });
    alice.express({ kind: "create-challenge" });
    await flushPromises();
    aliceHost.deliverSent(0);
    bobHost.deliver(aliceHost.sent[0]!);
    await flushPromises();
    const challengeId = bob.current().competition.openChallenges[0]!.challengeId;
    bob.express({ kind: "join-challenge", challengeId });
    await flushPromises();
    const claim = bobHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "challenge-claimed"
    )!;
    bobHost.deliver(claim);
    aliceHost.deliver(claim);
    await flushPromises();
    const pairingId = alice.current().competition.startingPairings[0]!.pairingId;
    const runtimeClaim = aliceHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "runtime-claimed"
    )!;

    const reference = alice.express({ kind: "leave-pairing", pairingId });
    await flushPromises();
    const left = aliceHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "pairing-left"
    )!;
    aliceHost.deliver(left);
    await flushPromises();
    expect(alice.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({ eventStatus: "deferred", settled: false });
    expect(alice.current().competition.startingPairings).toHaveLength(1);

    aliceHost.deliver(runtimeClaim);
    await flushPromises();
    expect(alice.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({ eventStatus: "effective" });
    expect(alice.current().competition.startingPairings).toEqual([]);
  });

  it("keeps an echoed match start deferred until readiness materializes", async () => {
    const {
      alice,
      aliceActor,
      aliceHost,
      bob,
      bobActor,
      bobHost,
      pairingId,
    } = await createPairedPlayers();
    const bobReadyReference = bob.express({
      kind: "set-readiness",
      pairingId,
      ready: true,
    });
    await flushPromises();
    const bobReady = bobHost.sent[bobHost.sent.length - 1]!;
    bobHost.deliver(bobReady);
    aliceHost.deliver(bobReady);
    await flushPromises();
    expect(bob.current().intents.find((intent) => intent.reference === bobReadyReference)).toMatchObject({
      settled: true,
    });

    alice.express({ kind: "set-readiness", pairingId, ready: true });
    await flushPromises();
    const aliceReady = aliceHost.sent[aliceHost.sent.length - 1]!;
    const seed = "00112233445566778899aabbccddeeff";
    const startReference = alice.express({ kind: "start-match", pairingId, seed });
    await flushPromises();
    const started = aliceHost.sent[aliceHost.sent.length - 1]!;

    expect(started).toMatchObject({
      payload: {
        kind: "match-started",
        pairingId,
        seed,
        seedHash: hashCanonicalHex({ seed }),
        seatAPlayerId: aliceActor.id,
        seatBPlayerId: bobActor.id,
        seatASessionId: "runtime-alice",
        seatBSessionId: "runtime-bob",
        configHash: hashCanonicalHex({
          rulesVersion: RULES.rulesVersion,
          rulesHash: "rules-current",
          seed,
          seatAPlayerId: aliceActor.id,
          seatBPlayerId: bobActor.id,
        }),
      },
    });
    aliceHost.deliver(started);
    bobHost.deliver(started);
    await flushPromises();

    expect(alice.current().competition.liveMatches).toEqual([]);
    expect(alice.current().intents.find((intent) => intent.reference === startReference)).toMatchObject({
      eventStatus: "deferred",
      feedbackStatus: "pending",
      settled: false,
    });
    expect(aliceHost.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId ===
        (started.payload as { eventId: string }).eventId &&
      update.info !== undefined
    )).toEqual([]);

    aliceHost.deliver(aliceReady);
    bobHost.deliver(aliceReady);
    await flushPromises();

    expect(alice.current().competition.liveMatches).toHaveLength(1);
    expect(alice.current().intents.find((intent) => intent.reference === startReference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    });
    const startFeedback = aliceHost.sent.find((update) =>
      (update.payload as { eventId?: string }).eventId ===
        (started.payload as { eventId: string }).eventId &&
      update.info !== undefined
    );
    expect(startFeedback).toMatchObject({
      info: "Alice vs Bob started.",
      summary: "0 wait · 1 live",
    });

    aliceHost.deliver(startFeedback!);
    await flushPromises();

    expect(alice.current().intents.find((intent) => intent.reference === startReference)).toMatchObject({
      feedbackStatus: "confirmed",
      settled: true,
    });
  });

  it("reopens and re-settles a confirmed start when late prerequisites revise materialization", async () => {
    const {
      alice,
      aliceActor,
      aliceHost,
      aliceStorage,
      pairingId,
      started,
    } = await createLiveMatch();
    const startReference = alice.current().intents.find((entry) =>
      entry.intent.kind === "start-match" && entry.intent.pairingId === pairingId
    )!.reference;
    const originalClaim = aliceHost.sent.find((update) =>
      (update.payload as { kind?: string; actor?: { id?: string } }).kind === "runtime-claimed" &&
      (update.payload as { actor?: { id?: string } }).actor?.id === aliceActor.id
    )!.payload as {
      eventId: string;
      logicalClock: number;
    };
    const replacement = {
      payload: {
        schema: "split-stack/competition/v2" as const,
        kind: "runtime-claimed" as const,
        eventId: `${originalClaim.eventId}:replacement`,
        logicalClock: originalClaim.logicalClock,
        actor: aliceActor,
        pairingId,
        runtimeSessionId: "runtime-alice-replacement",
      },
    };

    aliceHost.deliver(replacement);
    await flushPromises();

    expect(alice.current().competition.liveMatches).toEqual([]);
    expect(alice.current().intents.find((entry) => entry.reference === startReference))
      .toMatchObject({
        eventStatus: "deferred",
        feedbackStatus: "confirmed",
        settled: false,
      });
    const deferredWrites = aliceStorage.writes.filter((write) =>
      write.key.startsWith("split-stack/competition-intents/")
    );
    const persistedWhileDeferred = JSON.parse(
      deferredWrites[deferredWrites.length - 1]!.value,
    ) as Array<{ reference?: string }>;
    expect(persistedWhileDeferred).toContainEqual(expect.objectContaining({
      reference: startReference,
    }));

    aliceHost.deliver({
      payload: {
        ...replacement.payload,
        eventId: `${originalClaim.eventId}:zz-restored`,
        runtimeSessionId: "runtime-alice",
      },
    });
    await flushPromises();

    expect(alice.current().competition.liveMatches).toMatchObject([{
      matchId: (started.payload as { matchId: string }).matchId,
    }]);
    expect(alice.current().intents.find((entry) => entry.reference === startReference))
      .toMatchObject({
        eventStatus: "effective",
        feedbackStatus: "confirmed",
        settled: true,
      });
  });

  it("suspends pending feedback while an effective start is revised to deferred", async () => {
    const {
      alice,
      aliceActor,
      aliceHost,
      aliceScheduler,
      aliceStorage,
      bob,
      bobHost,
      pairingId,
    } = await createPairedPlayers();
    alice.express({ kind: "set-readiness", pairingId, ready: true });
    bob.express({ kind: "set-readiness", pairingId, ready: true });
    await flushPromises();
    const aliceReady = aliceHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "ready-changed"
    )!;
    const bobReady = bobHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "ready-changed"
    )!;
    aliceHost.deliver(aliceReady);
    aliceHost.deliver(bobReady);
    bobHost.deliver(aliceReady);
    bobHost.deliver(bobReady);
    await flushPromises();
    const startReference = alice.express({
      kind: "start-match",
      pairingId,
      seed: "00112233445566778899aabbccddeeff",
    });
    await flushPromises();
    const started = aliceHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "match-started"
    )!;
    (aliceHost as InMemoryDurableWebxdc & { sendUpdateInterval: number })
      .sendUpdateInterval = 1_000;
    aliceHost.deliver(started);
    await flushPromises();
    const startedEventId = (started.payload as { eventId: string }).eventId;
    expect(alice.current().intents.find((entry) => entry.reference === startReference))
      .toMatchObject({
        eventStatus: "effective",
        feedbackStatus: "pending",
        settled: false,
      });
    expect(aliceHost.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId === startedEventId &&
      update.info !== undefined
    )).toHaveLength(0);

    const originalClaim = aliceHost.sent.find((update) =>
      (update.payload as { kind?: string; actor?: { id?: string } }).kind === "runtime-claimed" &&
      (update.payload as { actor?: { id?: string } }).actor?.id === aliceActor.id
    )!.payload as { eventId: string; logicalClock: number };
    const replacement = {
      payload: {
        schema: "split-stack/competition/v2" as const,
        kind: "runtime-claimed" as const,
        eventId: `${originalClaim.eventId}:replacement`,
        logicalClock: originalClaim.logicalClock,
        actor: aliceActor,
        pairingId,
        runtimeSessionId: "runtime-alice-replacement",
      },
    };
    aliceHost.deliver(replacement);
    await flushPromises();
    aliceScheduler.advanceBy(2_000);
    await flushPromises();

    expect(alice.current().intents.find((entry) => entry.reference === startReference))
      .toMatchObject({
        eventStatus: "deferred",
        feedbackStatus: "pending",
        settled: false,
      });
    expect(aliceHost.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId === startedEventId &&
      update.info !== undefined
    )).toHaveLength(0);

    const replayHost = new InMemoryDurableWebxdc(aliceActor);
    let releaseReplay!: () => void;
    replayHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const initializing = createCompetitionEventLifecycle({
      actor: aliceActor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host: replayHost,
      storage: aliceStorage,
      scheduler: new ManualScheduler(),
      createId: () => "reloaded-private-id",
    });
    await flushPromises();
    const replayByEventId = new Map<string, unknown>();
    for (const update of [...aliceHost.sent, ...bobHost.sent]) {
      const payload = update.payload as { eventId?: string };
      if (payload.eventId !== undefined && !replayByEventId.has(payload.eventId)) {
        replayByEventId.set(payload.eventId, update.payload);
      }
    }
    for (const payload of replayByEventId.values()) replayHost.deliver({ payload });
    replayHost.deliver(replacement);
    releaseReplay();
    const reloaded = await initializing;
    await flushPromises();

    expect(reloaded.current().intents.find((entry) => entry.reference === startReference))
      .toMatchObject({ eventStatus: "deferred", feedbackStatus: "pending" });
    expect(replayHost.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId === startedEventId &&
      update.info !== undefined
    )).toEqual([]);

    replayHost.deliver({
      payload: {
        ...replacement.payload,
        eventId: `${originalClaim.eventId}:zz-restored`,
        runtimeSessionId: "runtime-alice",
      },
    });
    await flushPromises();
    expect(reloaded.current().intents.find((entry) => entry.reference === startReference))
      .toMatchObject({ eventStatus: "effective", feedbackStatus: "pending" });
    expect(replayHost.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId === startedEventId &&
      update.info !== undefined
    )).toHaveLength(1);
  });

  it("finishes an explicit match while deriving canonical result identity", async () => {
    const {
      alice,
      aliceActor,
      aliceHost,
      bobActor,
      bobHost,
      matchId,
      seed,
      started,
    } = await createLiveMatch();
    const stats = (score: number) => ({
      score,
      lines: 4,
      garbageSent: 2,
      powersActivated: 1,
      tetrises: 1,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    });

    const reference = alice.express({
      kind: "finish-match",
      matchId,
      result: {
        outcome: "seat-a",
        reason: "top-out",
        durationTicks: 900,
        finalLevel: 3,
        statsByPlayer: {
          [aliceActor.id]: stats(1_200),
          [bobActor.id]: stats(800),
        },
        completedBy: aliceActor.id,
      },
    });
    await flushPromises();
    const finished = aliceHost.sent[aliceHost.sent.length - 1]!;

    expect(finished).toMatchObject({
      payload: {
        kind: "match-finished",
        matchId,
        startedEventId: (started.payload as { eventId: string }).eventId,
        result: {
          schema: "split-stack/result/v1",
          matchId,
          seedHash: hashCanonicalHex({ seed }),
          players: [aliceActor, bobActor],
          outcome: "seat-a",
          statsByPlayer: {
            [aliceActor.id]: { score: 1_200 },
            [bobActor.id]: { score: 800 },
          },
        },
      },
    });
    expect(alice.current().competition.liveMatches).toHaveLength(1);
    expect(alice.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      eventStatus: "unconfirmed",
      feedbackStatus: "pending",
      settled: false,
    });

    aliceHost.deliver(finished);
    bobHost.deliver(finished);
    await flushPromises();

    expect(alice.current().competition.liveMatches).toEqual([]);
    expect(alice.current().competition.recentResults[0]).toMatchObject({
      matchId,
      result: { outcome: "seat-a" },
    });
    expect(alice.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    });
    const resultFeedback = aliceHost.sent[aliceHost.sent.length - 1]!;
    expect(resultFeedback).toMatchObject({
      payload: finished.payload,
      href: expect.stringContaining(encodeURIComponent(matchId)),
      notify: {
        [aliceActor.id]: expect.any(String),
        [bobActor.id]: expect.any(String),
      },
      summary: "0 wait · 0 live",
    });

    aliceHost.deliver(resultFeedback);
    await flushPromises();

    expect(alice.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      feedbackStatus: "confirmed",
      settled: true,
    });
  });

  it("keeps private Competition Event identity out of the public Competition view", async () => {
    const { alice, started } = await createLiveMatch();
    const live = alice.current().competition.liveMatches[0] as unknown as Record<string, unknown>;
    const publicStart = live.start as Record<string, unknown>;
    const startedEventId = (started.payload as { eventId: string }).eventId;

    expect(live).not.toHaveProperty("startedEventId");
    expect(publicStart).not.toHaveProperty("eventId");
    expect(publicStart).not.toHaveProperty("logicalClock");
    expect(publicStart).not.toHaveProperty("actor");
    expect(JSON.stringify(alice.current().competition)).not.toContain(startedEventId);
  });

  it("keeps an early finish deferred with its start and resolves both from a later prerequisite", async () => {
    const {
      alice,
      aliceActor,
      aliceHost,
      bob,
      bobActor,
      bobHost,
      pairingId,
    } = await createPairedPlayers();
    bob.express({ kind: "set-readiness", pairingId, ready: true });
    await flushPromises();
    const bobReady = bobHost.sent[bobHost.sent.length - 1]!;
    bobHost.deliver(bobReady);
    aliceHost.deliver(bobReady);
    await flushPromises();
    alice.express({ kind: "set-readiness", pairingId, ready: true });
    await flushPromises();
    const aliceReady = aliceHost.sent[aliceHost.sent.length - 1]!;
    const seed = "00112233445566778899aabbccddeeff";
    const startReference = alice.express({ kind: "start-match", pairingId, seed });
    await flushPromises();
    const started = aliceHost.sent[aliceHost.sent.length - 1]!;
    aliceHost.deliver(started);
    bobHost.deliver(started);
    await flushPromises();
    const stats = (score: number) => ({
      score,
      lines: 1,
      garbageSent: 0,
      powersActivated: 0,
      tetrises: 0,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    });
    const matchId = (started.payload as { matchId: string }).matchId;

    const finishReference = alice.express({
      kind: "finish-match",
      matchId,
      result: {
        outcome: "seat-a",
        reason: "top-out",
        durationTicks: 120,
        finalLevel: 1,
        statsByPlayer: {
          [aliceActor.id]: stats(400),
          [bobActor.id]: stats(200),
        },
        completedBy: aliceActor.id,
      },
    });
    await flushPromises();
    const finished = aliceHost.sent[aliceHost.sent.length - 1]!;
    aliceHost.deliver(finished);
    bobHost.deliver(finished);
    await flushPromises();

    expect(alice.current().intents.find((intent) => intent.reference === finishReference)).toMatchObject({
      eventStatus: "deferred",
      feedbackStatus: "pending",
      settled: false,
    });
    expect(alice.current().competition.recentResults).toEqual([]);

    aliceHost.deliver(aliceReady);
    bobHost.deliver(aliceReady);
    await flushPromises();

    expect(alice.current().intents.find((intent) => intent.reference === startReference)).toMatchObject({
      eventStatus: "effective",
    });
    expect(alice.current().intents.find((intent) => intent.reference === finishReference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    });
    expect(alice.current().competition.recentResults[0]).toMatchObject({ matchId });
    const finishFeedback = aliceHost.sent.find((update) =>
      (update.payload as { eventId?: string }).eventId ===
        (finished.payload as { eventId: string }).eventId &&
      update.info !== undefined
    );
    expect(finishFeedback).toBeDefined();

    aliceHost.deliver(finishFeedback!);
    await flushPromises();

    expect(alice.current().intents.find((intent) => intent.reference === finishReference)).toMatchObject({
      feedbackStatus: "confirmed",
      settled: true,
    });
  });

  it("binds an early finish to the application-tuple-first deferred start", async () => {
    const {
      alice,
      aliceActor,
      aliceHost,
      bobActor,
      pairingId,
    } = await createPairedPlayers();
    const pairing = alice.current().competition.startingPairings.find((candidate) =>
      candidate.pairingId === pairingId
    )!;
    const makeStart = (eventId: string, seed: string) => ({
      schema: "split-stack/competition/v2" as const,
      kind: "match-started" as const,
      eventId,
      logicalClock: 100,
      actor: aliceActor,
      pairingId,
      seriesId: pairing.seriesId,
      round: pairing.round,
      matchId: pairing.matchId,
      rulesHash: "rules-current",
      configHash: hashCanonicalHex({
        rulesVersion: RULES.rulesVersion,
        rulesHash: "rules-current",
        seed,
        seatAPlayerId: pairing.seatA.id,
        seatBPlayerId: pairing.seatB.id,
      }),
      seed,
      seedHash: hashCanonicalHex({ seed }),
      seatAPlayerId: pairing.seatA.id,
      seatBPlayerId: pairing.seatB.id,
      seatASessionId: pairing.runtimeSessionByPlayer[pairing.seatA.id]!,
      seatBSessionId: pairing.runtimeSessionByPlayer[pairing.seatB.id]!,
    });
    const laterTuple = makeStart(
      "zzz-deferred-start",
      "ffeeddccbbaa99887766554433221100",
    );
    const earlierTuple = makeStart(
      "aaa-deferred-start",
      "00112233445566778899aabbccddeeff",
    );
    aliceHost.deliver({ payload: laterTuple });
    aliceHost.deliver({ payload: earlierTuple });
    await flushPromises();

    alice.express({
      kind: "finish-match",
      matchId: pairing.matchId,
      result: {
        outcome: "seat-a",
        reason: "top-out",
        durationTicks: 120,
        finalLevel: 1,
        statsByPlayer: {
          [aliceActor.id]: {
            score: 400,
            lines: 1,
            garbageSent: 0,
            powersActivated: 0,
            tetrises: 0,
            tSpinSingles: 0,
            tSpinDoubles: 0,
            tSpinTriples: 0,
          },
          [bobActor.id]: {
            score: 200,
            lines: 1,
            garbageSent: 0,
            powersActivated: 0,
            tetrises: 0,
            tSpinSingles: 0,
            tSpinDoubles: 0,
            tSpinTriples: 0,
          },
        },
        completedBy: aliceActor.id,
      },
    });
    await flushPromises();
    const finished = [...aliceHost.sent].reverse().find((update) =>
      (update.payload as { kind?: string }).kind === "match-finished"
    )!;

    expect(finished).toMatchObject({
      payload: {
        startedEventId: earlierTuple.eventId,
        result: { seedHash: earlierTuple.seedHash },
      },
    });
  });

  it("concedes an explicit match without exposing the committed start identity", async () => {
    const { aliceActor, aliceHost, bob, bobActor, bobHost, matchId, started } =
      await createLiveMatch();

    const reference = bob.express({ kind: "concede-match", matchId });
    await flushPromises();
    const conceded = bobHost.sent[bobHost.sent.length - 1]!;

    expect(conceded).toMatchObject({
      payload: {
        kind: "match-conceded",
        matchId,
        startedEventId: (started.payload as { eventId: string }).eventId,
        actor: bobActor,
      },
    });
    bobHost.deliver(conceded);
    aliceHost.deliver(conceded);
    await flushPromises();

    expect(bob.current().competition.recentResults[0]).toMatchObject({
      matchId,
      result: {
        outcome: "seat-a",
        reason: "forfeit",
      },
    });
    const feedback = bobHost.sent[bobHost.sent.length - 1]!;
    expect(feedback).toMatchObject({
      payload: conceded.payload,
      info: "Bob conceded · Alice wins",
      notify: {
        [aliceActor.id]: "Bob conceded · Alice wins",
        [bobActor.id]: "Bob conceded · Alice wins",
      },
    });
    expect(bob.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    });

    bobHost.deliver(feedback);
    await flushPromises();

    expect(bob.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      feedbackStatus: "confirmed",
      settled: true,
    });
  });

  it("reasserts an unconfirmed concession with the same private identity", async () => {
    const { bob, bobHost, bobScheduler, matchId } = await createLiveMatch();

    const reference = bob.express({ kind: "concede-match", matchId });
    await flushPromises();
    const first = bobHost.sent[bobHost.sent.length - 1]!;

    bobScheduler.advanceBy(1_000);
    await flushPromises();
    expect(bobHost.sent.filter((update) =>
      (update.payload as { kind?: string }).kind === "match-conceded"
    )).toHaveLength(2);

    const retriedReference = bob.express({ kind: "concede-match", matchId });
    await flushPromises();
    const concessions = bobHost.sent.filter((update) =>
      (update.payload as { kind?: string }).kind === "match-conceded"
    );

    expect(retriedReference).toBe(reference);
    expect(concessions).toHaveLength(3);
    expect(concessions[2]).toEqual(first);
    expect(bob.current().intents.filter((entry) =>
      entry.intent.kind === "concede-match" && entry.intent.matchId === matchId
    )).toHaveLength(1);

    bobScheduler.advanceBy(1_000);
    await flushPromises();
    expect(bobHost.sent.filter((update) =>
      (update.payload as { kind?: string }).kind === "match-conceded"
    )).toHaveLength(3);
  });

  it("settles an explicit connection loss neutrally without changing standings", async () => {
    const { alice, aliceActor, aliceHost, bobHost, matchId } = await createLiveMatch();

    const reference = alice.express({ kind: "settle-connection-loss", matchId });
    await flushPromises();
    const finished = aliceHost.sent[aliceHost.sent.length - 1]!;

    expect(finished).toMatchObject({
      payload: {
        kind: "match-finished",
        eventId: expect.stringMatching(/^connection-lost:/u),
        matchId,
        actor: aliceActor,
        result: {
          outcome: "desync",
          reason: "connection-lost",
        },
      },
    });
    aliceHost.deliver(finished);
    bobHost.deliver(finished);
    await flushPromises();

    expect(alice.current().competition.recentResults[0]).toMatchObject({
      matchId,
      result: { outcome: "desync", reason: "connection-lost" },
    });
    expect(alice.current().competition.standings).toEqual([]);
    expect(alice.current().competition.headToHead).toEqual([]);
    const feedback = aliceHost.sent[aliceHost.sent.length - 1]!;
    expect(feedback).toMatchObject({
      payload: finished.payload,
      summary: "0 wait · 0 live",
    });
    expect(feedback.info).toBeUndefined();
    expect(feedback.href).toBeUndefined();
    expect(feedback.notify).toBeUndefined();
    expect(alice.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    });

    aliceHost.deliver(feedback);
    await flushPromises();

    expect(alice.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      feedbackStatus: "confirmed",
      settled: true,
    });
  });

  it("reloads a controller-authored connection-lost finish as the same finish intent", async () => {
    const { alice, aliceActor, aliceHost, aliceStorage, bobActor, matchId } =
      await createLiveMatch();
    const stats = (score: number) => ({
      score,
      lines: 1,
      garbageSent: 0,
      powersActivated: 0,
      tetrises: 0,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    });
    const reference = alice.express({
      kind: "finish-match",
      matchId,
      result: {
        outcome: "desync",
        reason: "connection-lost",
        durationTicks: 600,
        finalLevel: 1,
        statsByPlayer: {
          [aliceActor.id]: stats(400),
          [bobActor.id]: stats(200),
        },
        completedBy: aliceActor.id,
      },
    });
    await flushPromises();
    const first = aliceHost.sent[aliceHost.sent.length - 1]!;

    const reloadedHost = new InMemoryDurableWebxdc(aliceActor);
    const reloaded = await createCompetitionEventLifecycle({
      actor: aliceActor,
      runtimeSessionId: "runtime-alice-reloaded",
      currentRulesHash: "rules-current",
      host: reloadedHost,
      storage: aliceStorage,
      scheduler: new ManualScheduler(),
      createId: () => {
        throw new Error("Reload must reuse persisted intent identity");
      },
    });
    await flushPromises();

    expect(reloaded.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        intent: {
          kind: "finish-match",
          matchId,
          result: { reason: "connection-lost" },
        },
        eventStatus: "unconfirmed",
        settled: false,
      });
    expect(reloadedHost.sent.filter((update) =>
      (update.payload as { kind?: string }).kind === "match-finished"
    )).toEqual([first]);
  });

  it("reserves primary recovery capacity for a terminal match intent", async () => {
    const {
      alice,
      aliceActor,
      aliceHost,
      aliceStorage,
      bobActor,
      matchId,
    } = await createLiveMatch();
    const practiceStats = (score: number) => ({
      score,
      lines: 1,
      garbageSent: 0,
      powersActivated: 0,
      tetrises: 0,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    });
    let admittedOptional = 0;
    let capacityError: unknown;
    for (let index = 0; index < 100; index += 1) {
      try {
        alice.express({
          kind: "complete-practice",
          runId: `capacity-practice-${index}`,
          durationTicks: 600,
          finalLevel: 1,
          finalStats: practiceStats(index + 1),
        });
        admittedOptional += 1;
      } catch (error) {
        capacityError = error;
        break;
      }
    }
    expect(admittedOptional).toBeGreaterThan(0);
    expect(admittedOptional).toBeLessThan(100);
    expect(capacityError).toBeInstanceOf(RangeError);

    const terminalReference = alice.express({
      kind: "finish-match",
      matchId,
      result: {
        outcome: "seat-a",
        reason: "top-out",
        durationTicks: 600,
        finalLevel: 1,
        statsByPlayer: {
          [aliceActor.id]: practiceStats(400),
          [bobActor.id]: practiceStats(200),
        },
        completedBy: aliceActor.id,
      },
    });
    await flushPromises();

    expect(alice.current().intents.find((entry) => entry.reference === terminalReference))
      .toMatchObject({ intent: { kind: "finish-match", matchId }, settled: false });
    expect(aliceHost.sent.some((update) =>
      (update.payload as { kind?: string }).kind === "match-finished"
    )).toBe(true);
    const intentWrites = aliceStorage.writes.filter((write) =>
      write.key.startsWith("split-stack/competition-intents/")
    );
    const persisted = JSON.parse(
      intentWrites[intentWrites.length - 1]!.value,
    ) as Array<{ payload?: { kind?: string } }>;
    expect(persisted.some((entry) => entry.payload?.kind === "match-finished")).toBe(true);
  });

  it("reserves encoded recovery headroom for a maximal terminal intent", async () => {
    const aliceActor = {
      id: `${"\u0001".repeat(252)}alce`,
      displayName: "\u0002".repeat(128),
    };
    const bobActor = {
      id: `${"\u0003".repeat(252)}bob!`,
      displayName: "\u0004".repeat(128),
    };
    let pressureIds = false;
    let ordinaryId = 0;
    let largeId = 0;
    const aliceCreateId = (): string => {
      if (!pressureIds) return `byte-fixture-${ordinaryId += 1}`;
      return `${"\u0000".repeat(248)}${(largeId += 1).toString(36).padStart(8, "0")}`;
    };
    const {
      alice,
      aliceHost,
      aliceStorage,
      matchId,
    } = await createLiveMatch({ aliceActor, bobActor, aliceCreateId });
    pressureIds = true;
    let capacityError: unknown;
    let admittedOptional = 0;
    for (let index = 0; index < 100; index += 1) {
      try {
        alice.express({ kind: "create-challenge" });
        admittedOptional += 1;
      } catch (error) {
        capacityError = error;
        break;
      }
    }
    expect(admittedOptional).toBeGreaterThan(0);
    expect(capacityError).toBeInstanceOf(RangeError);

    const stats = (score: number) => ({
      score,
      lines: 1,
      garbageSent: 0,
      powersActivated: 0,
      tetrises: 0,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    });
    const reference = alice.express({
      kind: "finish-match",
      matchId,
      result: {
        outcome: "seat-a",
        reason: "top-out",
        durationTicks: 600,
        finalLevel: 1,
        statsByPlayer: {
          [aliceActor.id]: stats(400),
          [bobActor.id]: stats(200),
        },
        completedBy: aliceActor.id,
      },
    });
    await flushPromises();

    expect(aliceHost.sent.some((update) =>
      (update.payload as { kind?: string }).kind === "match-finished"
    )).toBe(true);
    const intentWrites = aliceStorage.writes.filter((write) =>
      write.key.startsWith("split-stack/competition-intents/")
    );
    const latest = intentWrites[intentWrites.length - 1]!;
    const records = JSON.parse(latest.value) as Array<{
      reference: string;
      payload: { kind: string };
    }>;
    const terminal = records.find((record) => record.reference === reference)!;
    expect(JSON.stringify(terminal).length).toBeGreaterThan(16_000);
    expect(latest.value.length).toBeLessThanOrEqual(448_000);
  });

  it("requests and accepts a rematch while keeping request event identity private", async () => {
    const {
      alice,
      aliceActor,
      aliceHost,
      bob,
      bobActor,
      bobHost,
      matchId,
    } = await createCompletedMatch();

    const requestReference = alice.express({ kind: "request-rematch", afterMatchId: matchId });
    await flushPromises();
    const requested = aliceHost.sent[aliceHost.sent.length - 1]!;

    expect(requested).toMatchObject({
      payload: {
        kind: "rematch-requested",
        afterMatchId: matchId,
        round: 2,
        actor: aliceActor,
      },
    });
    aliceHost.deliver(requested);
    bobHost.deliver(requested);
    await flushPromises();

    expect(alice.current().competition.pendingRematches[0]).toMatchObject({
      afterMatchId: matchId,
      round: 2,
      requestedByPlayerIds: [aliceActor.id],
    });
    const requestFeedback = aliceHost.sent[aliceHost.sent.length - 1]!;
    expect(requestFeedback).toMatchObject({
      payload: requested.payload,
      notify: { [bobActor.id]: "Alice requested a rematch" },
    });
    aliceHost.deliver(requestFeedback);
    await flushPromises();
    expect(alice.current().intents.find((intent) => intent.reference === requestReference)).toMatchObject({
      feedbackStatus: "confirmed",
      settled: true,
    });

    const acceptReference = bob.express({ kind: "accept-rematch", afterMatchId: matchId });
    await flushPromises();
    const accepted = bobHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "rematch-accepted"
    )!;

    expect(accepted).toMatchObject({
      payload: {
        kind: "rematch-accepted",
        afterMatchId: matchId,
        round: 2,
        requestedEventId: (requested.payload as { eventId: string }).eventId,
        actor: bobActor,
      },
    });
    bobHost.deliver(accepted);
    aliceHost.deliver(accepted);
    await flushPromises();

    expect(bob.current().competition.startingPairings[0]).toMatchObject({
      source: "rematch",
      round: 2,
      seatA: aliceActor,
      seatB: bobActor,
    });
    expect(bob.current().intents.find((intent) => intent.reference === acceptReference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "not-required",
      settled: true,
    });
    expect(bobHost.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId ===
        (accepted.payload as { eventId: string }).eventId &&
      (update.info !== undefined || update.summary !== undefined || update.notify !== undefined)
    )).toEqual([]);
  });

  it("completes Practice and announces only a new canonical record", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const stats = (score: number) => ({
      score,
      lines: 8,
      garbageSent: 0,
      powersActivated: 2,
      tetrises: 1,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    });

    const recordReference = lifecycle.express({
      kind: "complete-practice",
      runId: "practice-run-1",
      durationTicks: 1_200,
      finalLevel: 4,
      finalStats: stats(5_000),
    });
    await flushPromises();
    const record = host.sent[0]!;

    expect(record).toMatchObject({
      payload: {
        kind: "practice-completed",
        rulesHash: "rules-current",
        runId: "practice-run-1",
        endReason: "top-out",
        score: 5_000,
        durationTicks: 1_200,
        finalLevel: 4,
        finalStats: {
          score: 5_000,
          topOutTick: 1_200,
        },
      },
    });
    host.deliver(record);
    await flushPromises();

    expect(lifecycle.current().competition.practice.record).toMatchObject({
      player: actor,
      score: 5_000,
    });
    const recordFeedback = host.sent[host.sent.length - 1]!;
    expect(recordFeedback).toMatchObject({
      payload: record.payload,
      info: "Alice set Practice record: 5,000",
      href: expect.stringContaining("practice/leaderboard"),
    });
    host.deliver(recordFeedback);
    await flushPromises();
    expect(lifecycle.current().intents.find((intent) => intent.reference === recordReference)).toMatchObject({
      feedbackStatus: "confirmed",
      settled: true,
    });

    const lowerReference = lifecycle.express({
      kind: "complete-practice",
      runId: "practice-run-2",
      durationTicks: 600,
      finalLevel: 2,
      finalStats: stats(1_000),
    });
    await flushPromises();
    const lower = host.sent[host.sent.length - 1]!;
    host.deliver(lower);
    await flushPromises();

    expect(lifecycle.current().competition.practice.record?.score).toBe(5_000);
    expect(lifecycle.current().intents.find((intent) => intent.reference === lowerReference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "not-required",
      settled: true,
    });
    expect(host.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId ===
        (lower.payload as { eventId: string }).eventId &&
      update.info !== undefined
    )).toEqual([]);
  });

  it("normalizes runtime intent objects to the exact public completion shapes", async () => {
    const {
      alice,
      aliceActor,
      bobActor,
      matchId,
    } = await createLiveMatch();
    const stats = (score: number) => ({
      score,
      lines: 1,
      garbageSent: 0,
      powersActivated: 0,
      tetrises: 0,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    });
    const finishReference = alice.express({
      kind: "finish-match",
      matchId,
      result: {
        schema: "split-stack/result/v1",
        matchId: "smuggled-match",
        seedHash: "smuggled-seed",
        players: [{ id: "mallory", displayName: "Mallory" }],
        outcome: "seat-a",
        reason: "top-out",
        durationTicks: 600,
        finalLevel: 1,
        statsByPlayer: {
          [aliceActor.id]: stats(400),
          [bobActor.id]: stats(200),
        },
        completedBy: aliceActor.id,
      },
    } as unknown as CompetitionIntent);
    const practiceReference = alice.express({
      kind: "complete-practice",
      runId: "practice-extra-fields",
      durationTicks: 600,
      finalLevel: 1,
      finalStats: {
        ...stats(500),
        topOutTick: 1,
      },
    } as unknown as CompetitionIntent);

    const finishIntent = alice.current().intents.find((entry) =>
      entry.reference === finishReference
    )!.intent as unknown as Record<string, unknown>;
    const finishResult = finishIntent.result as Record<string, unknown>;
    const practiceIntent = alice.current().intents.find((entry) =>
      entry.reference === practiceReference
    )!.intent as unknown as Record<string, unknown>;
    const practiceStats = practiceIntent.finalStats as Record<string, unknown>;

    expect(Object.keys(finishResult).sort()).toEqual([
      "completedBy",
      "durationTicks",
      "finalLevel",
      "outcome",
      "reason",
      "statsByPlayer",
    ]);
    expect(practiceStats).not.toHaveProperty("topOutTick");
  });

  it("reuses the persisted private event identity after a reload", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const firstHost = new InMemoryDurableWebxdc(actor);
    let firstId = 0;
    const first = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice-first",
      currentRulesHash: "rules-current",
      host: firstHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `first-private-${firstId += 1}`,
    });
    const reference = first.express({ kind: "create-challenge" });
    await flushPromises();
    const firstPayload = structuredClone(firstHost.sent[0]!.payload) as { eventId: string };

    const reloadedHost = new InMemoryDurableWebxdc(actor);
    const reloaded = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice-reloaded",
      currentRulesHash: "rules-current",
      host: reloadedHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => "must-not-create-another-identity",
    });
    await flushPromises();

    expect(reloadedHost.sent[0]?.payload).toEqual(firstPayload);
    expect(reloaded.current().intents).toMatchObject([{
      reference,
      eventStatus: "unconfirmed",
      settled: false,
    }]);
    expect(String(reference)).not.toBe(firstPayload.eventId);
  });

  it("defers recovered feedback and derived events until the complete replay is known", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(actor);
    let admittingId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-before-reload",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `admitting-${admittingId += 1}`,
    });
    const reference = admitting.express({ kind: "create-challenge" });
    await flushPromises();
    const created = admittingHost.sent[0]!;
    const createdPayload = created.payload as {
      eventId: string;
      logicalClock: number;
      challengeId: string;
      vacancyId: string;
    };

    const replayHost = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    replayHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let replayId = 0;
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-after-reload",
      currentRulesHash: "rules-current",
      host: replayHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `replay-${replayId += 1}`,
    });
    await flushPromises();

    replayHost.deliver(created);
    replayHost.deliver({
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-claimed",
        eventId: "bob-claim",
        logicalClock: createdPayload.logicalClock + 1,
        actor: { id: "bob@example.test", displayName: "Bob" },
        challengeId: createdPayload.challengeId,
        vacancyId: createdPayload.vacancyId,
      },
    });
    await flushPromises();

    expect(replayHost.sent).toEqual([]);

    releaseReplay();
    const reloaded = await initializing;
    await flushPromises();

    expect(reloaded.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "pending",
    });
    expect(replayHost.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId === createdPayload.eventId &&
      update.info !== undefined
    )).toHaveLength(1);
    expect(replayHost.sent.some((update) =>
      (update.payload as { kind?: string }).kind === "runtime-claimed"
    )).toBe(true);
  });

  it("reloads the exact persisted payload and reference after the first send rejects", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    let rejectFirstSend = true;
    const firstHost = new InMemoryDurableWebxdc(actor, () => {
      if (!rejectFirstSend) return;
      rejectFirstSend = false;
      throw new Error("transient durable failure");
    });
    let nextId = 0;
    const first = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-first",
      currentRulesHash: "rules-current",
      host: firstHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });

    const reference = first.express({ kind: "create-challenge" });
    await flushPromises();
    expect(firstHost.sent).toEqual([]);
    expect(firstHost.attempted).toHaveLength(1);
    const attemptedPayload = structuredClone(firstHost.attempted[0]!.payload);

    const reloadedHost = new InMemoryDurableWebxdc(actor);
    const reloaded = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-reloaded",
      currentRulesHash: "rules-current",
      host: reloadedHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => {
        throw new Error("recovery must not allocate a new identity");
      },
    });
    await flushPromises();

    expect(reloadedHost.sent).toMatchObject([{ payload: attemptedPayload }]);
    expect(reloaded.current().intents).toMatchObject([{
      reference,
      eventStatus: "unconfirmed",
      settled: false,
    }]);
  });

  it("ignores persisted records whose domain intent does not match their payload", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-admitting",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    admitting.express({ kind: "create-challenge" });
    await flushPromises();
    const intentWrites = storage.writes.filter((write) =>
      write.key.startsWith("split-stack/competition-intents/")
    );
    const intentWrite = intentWrites[intentWrites.length - 1]!;
    const corrupted = JSON.parse(intentWrite.value) as Array<Record<string, unknown>>;
    corrupted[0]!.intent = {
      kind: "cancel-challenge",
      challengeId: "unrelated-challenge",
    };
    storage.setItem(intentWrite.key, JSON.stringify(corrupted));

    const recoveredHost = new InMemoryDurableWebxdc(actor);
    const recovered = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-recovered",
      currentRulesHash: "rules-current",
      host: recoveredHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => "unused",
    });
    await flushPromises();

    expect(recovered.current().intents).toEqual([]);
    expect(recoveredHost.sent).toEqual([]);
  });

  it("ignores persisted records whose intent contains fields outside the public shape", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-admitting",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    admitting.express({ kind: "create-challenge" });
    await flushPromises();
    const intentWrites = storage.writes.filter((write) =>
      write.key.startsWith("split-stack/competition-intents/")
    );
    const intentWrite = intentWrites[intentWrites.length - 1]!;
    const corrupted = JSON.parse(intentWrite.value) as Array<Record<string, unknown>>;
    corrupted[0]!.intent = {
      kind: "create-challenge",
      eventId: "private-event-injected-into-public-intent",
    };
    storage.setItem(intentWrite.key, JSON.stringify(corrupted));

    const recoveredHost = new InMemoryDurableWebxdc(actor);
    const recovered = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-recovered",
      currentRulesHash: "rules-current",
      host: recoveredHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => "unused",
    });
    await flushPromises();

    expect(recovered.current().intents).toEqual([]);
    expect(recoveredHost.sent).toEqual([]);
  });

  it("rejects persisted references and event IDs that collide across identity namespaces", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-admitting",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    admitting.express({ kind: "create-challenge" });
    await flushPromises();
    const intentWrites = storage.writes.filter((write) =>
      write.key.startsWith("split-stack/competition-intents/")
    );
    const intentWrite = intentWrites[intentWrites.length - 1]!;
    const [first] = JSON.parse(intentWrite.value) as Array<{
      reference: string;
      payload: Record<string, unknown>;
    }>;
    const referenceCollidesWithEvent = structuredClone(first!);
    referenceCollidesWithEvent.reference = first!.payload.eventId as string;
    referenceCollidesWithEvent.payload.eventId = "second-private-event";
    referenceCollidesWithEvent.payload.challengeId = "second-challenge";
    referenceCollidesWithEvent.payload.vacancyId = "second-vacancy";
    const eventCollidesWithReference = structuredClone(first!);
    eventCollidesWithReference.reference = "third-private-reference";
    eventCollidesWithReference.payload.eventId = first!.reference;
    eventCollidesWithReference.payload.challengeId = "third-challenge";
    eventCollidesWithReference.payload.vacancyId = "third-vacancy";
    storage.setItem(intentWrite.key, JSON.stringify([
      first,
      referenceCollidesWithEvent,
      eventCollidesWithReference,
    ]));

    const recoveredHost = new InMemoryDurableWebxdc(actor);
    const recovered = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-recovered",
      currentRulesHash: "rules-current",
      host: recoveredHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => "unused",
    });
    await flushPromises();

    expect(recovered.current().intents).toHaveLength(1);
    expect(recovered.current().intents[0]).toMatchObject({
      reference: first!.reference,
    });
    expect(recoveredHost.sent.filter((update) =>
      (update.payload as { kind?: string }).kind === "challenge-created"
    )).toHaveLength(1);
  });

  it("never reuses a previously generated domain identity for a later admission", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    const generated = [
      "first-event",
      "first-reference",
      "first-challenge",
      "first-vacancy",
      "cancel-event",
      "cancel-reference",
      "second-event",
      "second-reference",
      "first-challenge",
    ];
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => generated.shift() ?? "unused",
    });
    lifecycle.express({ kind: "create-challenge" });
    await flushPromises();
    const created = host.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "challenge-created"
    )!;
    host.deliver(created);
    await flushPromises();
    const challengeId = (created.payload as { challengeId: string }).challengeId;
    lifecycle.express({ kind: "cancel-challenge", challengeId });
    await flushPromises();
    const cancelled = host.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "challenge-cancelled"
    )!;
    host.deliver(cancelled);
    await flushPromises();
    const beforeIntents = lifecycle.current().intents.length;
    const beforeSends = host.sent.length;

    expect(() => lifecycle.express({ kind: "create-challenge" })).toThrow(/unique/iu);
    expect(lifecycle.current().intents).toHaveLength(beforeIntents);
    expect(host.sent).toHaveLength(beforeSends);
  });

  it("ignores persisted feedback context that is invalid for its Competition Event", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-admitting",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    admitting.express({
      kind: "complete-practice",
      runId: "practice-run-1",
      durationTicks: 600,
      finalLevel: 2,
      finalStats: {
        score: 5_000,
        lines: 10,
        garbageSent: 0,
        powersActivated: 1,
        tetrises: 2,
        tSpinSingles: 0,
        tSpinDoubles: 0,
        tSpinTriples: 0,
      },
    });
    await flushPromises();
    const completed = admittingHost.sent[0]!;
    const intentWrites = storage.writes.filter((write) =>
      write.key.startsWith("split-stack/competition-intents/")
    );
    const intentWrite = intentWrites[intentWrites.length - 1]!;
    const corrupted = JSON.parse(intentWrite.value) as Array<Record<string, unknown>>;
    corrupted[0]!.feedbackContext = {
      kind: "practice-record",
      previousRecord: -1,
    };
    storage.setItem(intentWrite.key, JSON.stringify(corrupted));

    const recoveredHost = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    recoveredHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-recovered",
      currentRulesHash: "rules-current",
      host: recoveredHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => {
        throw new Error("invalid recovery data must not allocate an identity");
      },
    });
    await flushPromises();
    recoveredHost.deliver(completed);
    releaseReplay();
    const recovered = await initializing;
    await flushPromises();

    expect(recovered.current().competition.practice.record?.score).toBe(5_000);
    expect(recovered.current().intents).toEqual([]);
    expect(recoveredHost.sent).toEqual([]);
  });

  it("ignores recovered runtime claims with a forged key or an already-owned identity", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-admitting",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    admitting.express({ kind: "create-challenge" });
    await flushPromises();
    const admittedPayload = structuredClone(admittingHost.sent[0]!.payload) as {
      eventId: string;
      logicalClock: number;
    };
    storage.setItem(
      "split-stack/competition-derived/v1:rules-current:alice@example.test",
      JSON.stringify([
        {
          schema: "split-stack/competition-derived/v1",
          key: "forged-runtime-key",
          payload: {
            schema: "split-stack/competition/v2",
            kind: "runtime-claimed",
            eventId: "forged-runtime-event",
            logicalClock: admittedPayload.logicalClock + 1,
            actor,
            pairingId: "pairing-forged",
            runtimeSessionId: "runtime-recovered",
          },
        },
        {
          schema: "split-stack/competition-derived/v1",
          key: "runtime:runtime-recovered:pairing-colliding",
          payload: {
            schema: "split-stack/competition/v2",
            kind: "runtime-claimed",
            eventId: admittedPayload.eventId,
            logicalClock: admittedPayload.logicalClock + 2,
            actor,
            pairingId: "pairing-colliding",
            runtimeSessionId: "runtime-recovered",
          },
        },
      ]),
    );

    const recoveredHost = new InMemoryDurableWebxdc(actor);
    const recovered = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-recovered",
      currentRulesHash: "rules-current",
      host: recoveredHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => {
        throw new Error("recovery must reuse the admitted identity");
      },
    });
    await flushPromises();

    expect(recovered.current().intents).toHaveLength(1);
    expect(recoveredHost.sent).toMatchObject([{ payload: admittedPayload }]);
    expect(recoveredHost.sent).toHaveLength(1);
  });

  it("rejects a recovered intent when replay contains a different payload with its event ID", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-admitting",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const reference = admitting.express({ kind: "create-challenge" });
    await flushPromises();
    const admittedPayload = admittingHost.sent[0]!.payload as {
      eventId: string;
      logicalClock: number;
    };

    const replayHost = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    replayHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-recovered",
      currentRulesHash: "rules-current",
      host: replayHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => "unused",
    });
    await flushPromises();
    replayHost.deliver({
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-created",
        eventId: admittedPayload.eventId,
        logicalClock: admittedPayload.logicalClock,
        actor,
        challengeId: "forged-challenge",
        rulesHash: "rules-current",
        vacancyId: "forged-vacancy",
      },
    });
    releaseReplay();
    const recovered = await initializing;
    await flushPromises();

    expect(recovered.current().competition.openChallenges).toMatchObject([{
      challengeId: "forged-challenge",
    }]);
    expect(recovered.current().intents.find((intent) => intent.reference === reference))
      .toMatchObject({
        eventStatus: "rejected",
        feedbackStatus: "not-required",
        settled: true,
      });
    expect(replayHost.sent).toEqual([]);
  });

  it("ignores a losing same-ID payload without rejecting the canonical local intent", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const reference = lifecycle.express({ kind: "create-challenge" });
    await flushPromises();
    const admitted = host.sent[0]!;
    host.deliver(admitted);
    await flushPromises();
    const feedback = host.sent.find((update) => update.info !== undefined)!;
    const admittedPayload = admitted.payload as Record<string, unknown>;

    host.deliver({
      payload: {
        ...structuredClone(admittedPayload),
        challengeId: "zzzz-forged-challenge",
        vacancyId: "zzzz-forged-vacancy",
      },
    });
    await flushPromises();

    expect(lifecycle.current().competition.openChallenges).toMatchObject([{
      challengeId: admittedPayload.challengeId,
    }]);
    expect(lifecycle.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        eventStatus: "effective",
        feedbackStatus: "pending",
        settled: false,
      });

    host.deliver(feedback);
    await flushPromises();
    expect(lifecycle.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({ feedbackStatus: "confirmed", settled: true });
  });

  it("restores required feedback when a rejected local event becomes effective again", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const reference = lifecycle.express({ kind: "create-challenge" });
    await flushPromises();
    const local = host.sent[0]!;
    host.deliver(local);
    await flushPromises();
    const localPayload = local.payload as { logicalClock: number };
    const earlierChallengeId = "earlier-challenge";

    host.deliver({
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-created",
        eventId: "aaa-earlier-create",
        logicalClock: localPayload.logicalClock,
        actor,
        challengeId: earlierChallengeId,
        rulesHash: "rules-current",
        vacancyId: "earlier-vacancy",
      },
    });
    await flushPromises();
    expect(lifecycle.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        eventStatus: "rejected",
        feedbackStatus: "not-required",
        settled: true,
      });

    host.deliver({
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-cancelled",
        eventId: "aab-earlier-cancel",
        logicalClock: localPayload.logicalClock,
        actor,
        challengeId: earlierChallengeId,
      },
    });
    await flushPromises();

    expect(lifecycle.current().competition.openChallenges).toMatchObject([{
      challengeId: (local.payload as { challengeId: string }).challengeId,
    }]);
    expect(lifecycle.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        eventStatus: "effective",
        feedbackStatus: "pending",
        settled: false,
      });
    const restoredFeedbackUpdates = host.sent.filter((update) =>
      (update.payload as { eventId?: string }).eventId ===
        (local.payload as { eventId: string }).eventId &&
      update.info !== undefined
    );
    const restoredFeedback = restoredFeedbackUpdates[restoredFeedbackUpdates.length - 1]!;
    host.deliver(restoredFeedback);
    await flushPromises();
    expect(lifecycle.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({ feedbackStatus: "confirmed", settled: true });
  });

  it("regenerates feedback after reload when only optional journal storage is degraded", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage((key) =>
      key.startsWith("split-stack/pending-chat-feedback/")
    );
    const firstHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const first = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-first",
      currentRulesHash: "rules-current",
      host: firstHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const reference = first.express({ kind: "create-challenge" });
    await flushPromises();
    const created = firstHost.sent[0]!;

    expect(() => firstHost.deliver(created)).not.toThrow();
    await flushPromises();
    expect(first.current().competition.openChallenges).toHaveLength(1);
    expect(first.current().intents.find((intent) => intent.reference === reference)).toMatchObject({
      eventStatus: "effective",
      feedbackStatus: "pending",
      settled: false,
    });

    const reloadedHost = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    reloadedHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-reloaded",
      currentRulesHash: "rules-current",
      host: reloadedHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => {
        throw new Error("recovery must reuse the admitted identity");
      },
    });
    await flushPromises();
    reloadedHost.deliver(created);
    releaseReplay();
    const reloaded = await initializing;
    await flushPromises();

    expect(reloaded.current().competition.openChallenges).toHaveLength(1);
    expect(reloadedHost.sent).toMatchObject([{
      payload: created.payload,
      info: "Alice is waiting for an opponent.",
      summary: "1 wait · 0 live",
    }]);
  });

  it("recognizes replayed metadata when optional journal persistence was unavailable", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage((key) =>
      key.startsWith("split-stack/pending-chat-feedback/")
    );
    const firstHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const first = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-first",
      currentRulesHash: "rules-current",
      host: firstHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const reference = first.express({ kind: "create-challenge" });
    await flushPromises();
    const raw = firstHost.sent[0]!;
    firstHost.deliver(raw);
    await flushPromises();
    const metadata = firstHost.sent.find((update) => update.info !== undefined)!;

    const replayHost = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    replayHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-reloaded",
      currentRulesHash: "rules-current",
      host: replayHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => {
        throw new Error("recovery must reuse the admitted identity");
      },
    });
    await flushPromises();
    replayHost.deliver(raw);
    replayHost.deliver(metadata);
    releaseReplay();
    const reloaded = await initializing;
    await flushPromises();

    expect(reloaded.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        eventStatus: "effective",
        feedbackStatus: "confirmed",
        settled: true,
      });
    expect(replayHost.sent).toEqual([]);
  });

  it("recognizes historical replayed metadata after later events change its projection", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage((key) =>
      key.startsWith("split-stack/pending-chat-feedback/")
    );
    const firstHost = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const first = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-first",
      currentRulesHash: "rules-current",
      host: firstHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const reference = first.express({ kind: "create-challenge" });
    await flushPromises();
    const raw = firstHost.sent[0]!;
    firstHost.deliver(raw);
    await flushPromises();
    const metadata = firstHost.sent.find((update) => update.info !== undefined)!;
    expect(metadata.summary).toBe("1 wait · 0 live");
    const laterChallenge = {
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-created",
        eventId: "later-bob-event",
        logicalClock: 100,
        actor: { id: "bob@example.test", displayName: "Bob" },
        challengeId: "later-bob-challenge",
        rulesHash: "rules-current",
        vacancyId: "later-bob-vacancy",
      },
    } as const;

    const replayHost = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    replayHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-reloaded",
      currentRulesHash: "rules-current",
      host: replayHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => {
        throw new Error("recovery must reuse the admitted identity");
      },
    });
    await flushPromises();
    replayHost.deliver(raw);
    replayHost.deliver(metadata);
    replayHost.deliver(laterChallenge);
    releaseReplay();
    const reloaded = await initializing;
    await flushPromises();

    expect(reloaded.current().competition.counts.waiting).toBe(2);
    expect(reloaded.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        eventStatus: "effective",
        feedbackStatus: "confirmed",
        settled: true,
      });
    expect(replayHost.sent).toEqual([]);
  });

  it("reuses one deterministic connection-loss intent reference", async () => {
    const { alice, aliceHost, matchId } = await createLiveMatch();

    const first = alice.express({ kind: "settle-connection-loss", matchId });
    await flushPromises();
    const sendsAfterFirst = aliceHost.sent.length;
    const second = alice.express({ kind: "settle-connection-loss", matchId });
    await flushPromises();

    expect(second).toBe(first);
    expect(aliceHost.sent).toHaveLength(sendsAfterFirst);
    expect(alice.current().intents.filter((intent) =>
      intent.intent.kind === "settle-connection-loss"
    )).toHaveLength(1);
  });

  it("rejects a deterministic connection-loss ID already owned by another event", async () => {
    const { alice, aliceActor, aliceHost, matchId, started } = await createLiveMatch();
    const startedEventId = (started.payload as { eventId: string }).eventId;
    const collisionId = `connection-lost:${hashCanonicalHex({
      startedEventId,
      actorId: aliceActor.id,
    })}`;
    aliceHost.deliver({
      payload: {
        schema: "split-stack/competition/v2",
        kind: "practice-completed",
        eventId: collisionId,
        logicalClock: 100,
        actor: aliceActor,
        rulesHash: "rules-current",
        runId: "colliding-practice-run",
        endReason: "top-out",
        score: 0,
        durationTicks: 1,
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
          topOutTick: 1,
        },
      },
    });
    await flushPromises();
    const sendsBefore = aliceHost.sent.length;

    expect(() => alice.express({ kind: "settle-connection-loss", matchId }))
      .toThrow(/identity collision/iu);
    expect(aliceHost.sent).toHaveLength(sendsBefore);
    expect(alice.current().competition.liveMatches).toHaveLength(1);
  });

  it("allocates only one opaque reference for repeated deterministic connection-loss admission", async () => {
    const live = await createLiveMatch();
    const replayByEventId = new Map<string, DurableOutboundUpdate<unknown>>();
    for (const update of [...live.aliceHost.sent, ...live.bobHost.sent]) {
      const payload = update.payload as { eventId?: unknown };
      if (typeof payload.eventId === "string" && !replayByEventId.has(payload.eventId)) {
        replayByEventId.set(payload.eventId, { payload: structuredClone(update.payload) });
      }
    }

    const replacementHost = new InMemoryDurableWebxdc(live.aliceActor);
    let releaseReplay!: () => void;
    replacementHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let allocations = 0;
    const initializing = createCompetitionEventLifecycle({
      actor: live.aliceActor,
      runtimeSessionId: "runtime-alice-replacement",
      currentRulesHash: "rules-current",
      host: replacementHost,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => {
        allocations += 1;
        if (allocations > 1) throw new Error("deterministic retry allocated another identity");
        return "replacement-intent-reference";
      },
    });
    await flushPromises();
    for (const update of replayByEventId.values()) replacementHost.deliver(update);
    releaseReplay();
    const replacement = await initializing;
    await flushPromises();

    const first = replacement.express({
      kind: "settle-connection-loss",
      matchId: live.matchId,
    });
    await flushPromises();
    const settlement = replacementHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "match-finished"
    )!;
    replacementHost.deliver(settlement);
    await flushPromises();
    expect(replacement.current().competition.liveMatches).toEqual([]);
    const second = replacement.express({
      kind: "settle-connection-loss",
      matchId: live.matchId,
    });
    await flushPromises();

    expect(second).toBe(first);
    expect(allocations).toBe(1);
    expect(replacement.current().intents.filter((intent) =>
      intent.intent.kind === "settle-connection-loss"
    )).toHaveLength(1);
  });

  it("keeps duplicate observer subscriptions independent", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const revisions: number[] = [];
    const observer = (snapshot: { revision: number }): void => {
      revisions.push(snapshot.revision);
    };
    const unsubscribeFirst = lifecycle.observe(observer);
    const unsubscribeSecond = lifecycle.observe(observer);
    await flushPromises();
    expect(revisions).toEqual([0, 0]);

    unsubscribeFirst();
    lifecycle.express({ kind: "create-challenge" });
    await flushPromises();

    expect(revisions).toEqual([0, 0, 1]);
    unsubscribeSecond();
  });

  it("bounds settled intent history across persistence and replay", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const storage = new MemoryStorage();
    const host = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `history-${nextId += 1}`,
    });
    const references: string[] = [];
    const replay: DurableOutboundUpdate<unknown>[] = [];

    for (let index = 0; index < 80; index += 1) {
      const reference = lifecycle.express({
        kind: "complete-practice",
        runId: `settled-run-${index}`,
        durationTicks: 600,
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
        },
      });
      references.push(reference);
      await flushPromises();
      const matchingUpdates = host.sent.filter((candidate) =>
        (candidate.payload as { kind?: string; runId?: string }).kind ===
            "practice-completed" &&
        (candidate.payload as { runId?: string }).runId === `settled-run-${index}`
      );
      const update = matchingUpdates[matchingUpdates.length - 1]!;
      replay.push(update);
      host.deliver(update);
      await flushPromises();
      expect(lifecycle.current().intents.find((entry) => entry.reference === reference))
        .toMatchObject({ eventStatus: "effective", settled: true });
    }

    expect(lifecycle.current().intents).toHaveLength(64);
    expect(lifecycle.current().intents.some((entry) =>
      entry.reference === references[0]
    )).toBe(false);
    const newestReference = references[references.length - 1];
    expect(lifecycle.current().intents.some((entry) =>
      entry.reference === newestReference
    )).toBe(true);
    const intentWrites = storage.writes.filter((write) =>
      write.key.startsWith("split-stack/competition-intents/")
    );
    const persisted = JSON.parse(
      intentWrites[intentWrites.length - 1]!.value,
    ) as Array<{ reference: string }>;
    expect(persisted).toHaveLength(64);
    expect(persisted.some((entry) => entry.reference === references[0])).toBe(false);
    expect(persisted.some((entry) => entry.reference === newestReference)).toBe(true);

    const replayHost = new InMemoryDurableWebxdc(actor);
    let releaseReplay!: () => void;
    replayHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let replayId = 0;
    const initializing = createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice-reloaded",
      currentRulesHash: "rules-current",
      host: replayHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `replay-history-${replayId += 1}`,
    });
    await flushPromises();
    for (const update of replay) replayHost.deliver(update);
    releaseReplay();
    const reloaded = await initializing;
    await flushPromises();

    expect(reloaded.current().intents).toHaveLength(64);
    expect(reloaded.current().intents.some((entry) =>
      entry.reference === references[0]
    )).toBe(false);
    expect(reloaded.current().intents.find((entry) =>
      entry.reference === newestReference
    )).toMatchObject({ eventStatus: "effective", settled: true });
    expect(replayHost.sent).toEqual([]);
  });

  it("revises a retained settled intent after reload without losing its reference or receipt", async () => {
    const bobActor = { id: "bob@example.test", displayName: "Bob" };
    const challenge = {
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-created",
        eventId: "retained-challenge-event",
        logicalClock: 1,
        actor: { id: "alice@example.test", displayName: "Alice" },
        challengeId: "retained-challenge",
        rulesHash: "rules-current",
        vacancyId: "retained-vacancy",
      },
    } as const;
    const storage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(bobActor);
    let admittingId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor: bobActor,
      runtimeSessionId: "runtime-bob",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `retained-${admittingId += 1}`,
    });
    admittingHost.deliver(challenge);
    const reference = admitting.express({
      kind: "join-challenge",
      challengeId: "retained-challenge",
    });
    await flushPromises();
    const bobClaim = admittingHost.sent.find((update) =>
      (update.payload as { kind?: string }).kind === "challenge-claimed"
    )!;
    admittingHost.deliver(bobClaim);
    await flushPromises();
    const bobFeedback = admittingHost.sent.find((update) =>
      (update.payload as { eventId?: string }).eventId ===
          (bobClaim.payload as { eventId: string }).eventId &&
      update.notify !== undefined
    )!;
    admittingHost.deliver(bobFeedback);
    await flushPromises();
    expect(admitting.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        eventStatus: "effective",
        feedbackStatus: "confirmed",
        settled: true,
      });

    const replayHost = new InMemoryDurableWebxdc(bobActor);
    let releaseReplay!: () => void;
    replayHost.listenerBarrier = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let replayId = 0;
    const initializing = createCompetitionEventLifecycle({
      actor: bobActor,
      runtimeSessionId: "runtime-bob-reloaded",
      currentRulesHash: "rules-current",
      host: replayHost,
      storage,
      scheduler: new ManualScheduler(),
      createId: () => `retained-replay-${replayId += 1}`,
    });
    await flushPromises();
    replayHost.deliver(challenge);
    replayHost.deliver(bobClaim);
    replayHost.deliver(bobFeedback);
    releaseReplay();
    const reloaded = await initializing;
    await flushPromises();
    expect(reloaded.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        eventStatus: "effective",
        feedbackStatus: "confirmed",
        settled: true,
      });

    replayHost.deliver({
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-claimed",
        eventId: "aaron-retained-claim",
        logicalClock: (bobClaim.payload as { logicalClock: number }).logicalClock,
        actor: { id: "aaron@example.test", displayName: "Aaron" },
        challengeId: challenge.payload.challengeId,
        vacancyId: challenge.payload.vacancyId,
      },
    });
    await flushPromises();

    expect(reloaded.current().intents.find((entry) => entry.reference === reference))
      .toMatchObject({
        reference,
        eventStatus: "rejected",
        feedbackStatus: "confirmed",
        settled: true,
      });
  });

  it("revises a settled local intent when an earlier application tuple later wins", async () => {
    const bobActor = { id: "bob@example.test", displayName: "Bob" };
    const challenge = {
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-created",
        eventId: "challenge-event",
        logicalClock: 1,
        actor: { id: "alice@example.test", displayName: "Alice" },
        challengeId: "challenge-1",
        rulesHash: "rules-current",
        vacancyId: "vacancy-1",
      },
    } as const;
    const admittingStorage = new MemoryStorage();
    const admittingHost = new InMemoryDurableWebxdc(bobActor);
    let admittingId = 0;
    const admitting = await createCompetitionEventLifecycle({
      actor: bobActor,
      runtimeSessionId: "runtime-bob",
      currentRulesHash: "rules-current",
      host: admittingHost,
      storage: admittingStorage,
      scheduler: new ManualScheduler(),
      createId: () => `admitting-${admittingId += 1}`,
    });
    admittingHost.deliver(challenge);
    const reference = admitting.express({
      kind: "join-challenge",
      challengeId: "challenge-1",
    });
    await flushPromises();
    const bobClaim = admittingHost.sent[0]!;
    const bobLogicalClock = (bobClaim.payload as { logicalClock: number }).logicalClock;
    const aaronClaim = {
      payload: {
        schema: "split-stack/competition/v2",
        kind: "challenge-claimed",
        eventId: "aaron-claim",
        logicalClock: bobLogicalClock,
        actor: { id: "aaron@example.test", displayName: "Aaron" },
        challengeId: "challenge-1",
        vacancyId: "vacancy-1",
      },
    } as const;

    const makeReplica = async (storage: MemoryStorage, label: string) => {
      const host = new InMemoryDurableWebxdc(bobActor);
      let nextId = 0;
      const lifecycle = await createCompetitionEventLifecycle({
        actor: bobActor,
        runtimeSessionId: `runtime-${label}`,
        currentRulesHash: "rules-current",
        host,
        storage,
        scheduler: new ManualScheduler(),
        createId: () => `${label}-${nextId += 1}`,
      });
      await flushPromises();
      return { host, lifecycle };
    };
    const first = await makeReplica(admittingStorage.copy(), "first");
    const second = await makeReplica(admittingStorage.copy(), "second");

    first.host.deliver(challenge);
    first.host.deliver(bobClaim);
    await flushPromises();
    const bobFeedback = first.host.sent.find((update) =>
      (update.payload as { eventId?: string }).eventId ===
        (bobClaim.payload as { eventId: string }).eventId &&
      update.notify !== undefined
    );
    expect(bobFeedback).toBeDefined();
    first.host.deliver(bobFeedback!);
    await flushPromises();
    expect(first.lifecycle.current().intents.find((intent) => intent.reference === reference))
      .toMatchObject({ eventStatus: "effective", settled: true });
    first.host.deliver(aaronClaim);

    second.host.deliver(challenge);
    second.host.deliver(aaronClaim);
    second.host.deliver(bobClaim);
    await flushPromises();

    expect(first.lifecycle.current().competition).toEqual(second.lifecycle.current().competition);
    expect(first.lifecycle.current().intents.find((intent) => intent.reference === reference))
      .toMatchObject({ eventStatus: "rejected", settled: true });
    expect(second.lifecycle.current().intents.find((intent) => intent.reference === reference))
      .toMatchObject({ eventStatus: "rejected", settled: true });
  });

  it("returns deeply immutable snapshots", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    lifecycle.express({ kind: "create-challenge" });
    await flushPromises();
    host.deliverSent(0);
    await flushPromises();
    const snapshot = lifecycle.current();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.competition)).toBe(true);
    expect(Object.isFrozen(snapshot.competition.openChallenges)).toBe(true);
    expect(Object.isFrozen(snapshot.competition.openChallenges[0])).toBe(true);
    expect(() => {
      (snapshot.competition.openChallenges as unknown as Array<unknown>).length = 0;
    }).toThrow();
    expect(lifecycle.current().competition.openChallenges).toHaveLength(1);
  });

  it("serializes each observer and isolates observer failures", async () => {
    const actor = { id: "alice@example.test", displayName: "Alice" };
    const host = new InMemoryDurableWebxdc(actor);
    let nextId = 0;
    const lifecycle = await createCompetitionEventLifecycle({
      actor,
      runtimeSessionId: "runtime-alice",
      currentRulesHash: "rules-current",
      host,
      storage: new MemoryStorage(),
      scheduler: new ManualScheduler(),
      createId: () => `private-${nextId += 1}`,
    });
    const releases: Array<() => void> = [];
    const serializedRevisions: number[] = [];
    const healthyRevisions: number[] = [];
    let activeDeliveries = 0;
    let maximumActiveDeliveries = 0;
    const unsubscribe = lifecycle.observe(async (snapshot) => {
      activeDeliveries += 1;
      maximumActiveDeliveries = Math.max(maximumActiveDeliveries, activeDeliveries);
      serializedRevisions.push(snapshot.revision);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeDeliveries -= 1;
    });
    lifecycle.observe(() => {
      throw new Error("observer failure");
    });
    lifecycle.observe((snapshot) => {
      healthyRevisions.push(snapshot.revision);
    });
    await flushPromises();

    lifecycle.express({ kind: "create-challenge" });
    await flushPromises();

    expect(serializedRevisions).toEqual([0]);
    expect(healthyRevisions).toEqual([0, 1]);
    expect(maximumActiveDeliveries).toBe(1);

    releases.shift()!();
    await flushPromises();
    expect(serializedRevisions).toEqual([0, 1]);
    expect(maximumActiveDeliveries).toBe(1);

    releases.shift()!();
    await flushPromises();
    unsubscribe();
    host.deliverSent(0);
    await flushPromises();

    expect(serializedRevisions).toEqual([0, 1]);
    expect(healthyRevisions).toEqual([0, 1, 2]);
  });
});
