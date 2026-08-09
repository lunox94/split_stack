import { RULES } from "../config/rules";
import { canonicalize, hashCanonicalHex } from "../domain/hashing";
import type { MatchResultV1, PlayerResultStats } from "../domain/types";
import type { StoragePort } from "../persistence/settings";
import {
  DurableLamportClock,
  WebxdcDurableLog,
  type DurableOutboundUpdate,
  type DurableReceivedUpdate,
  type DurableWebxdcHost,
} from "../network/webxdc-durable";
import {
  COMPETITION_EVENT_SCHEMA_V2,
  CompetitionLedgerV2,
  isCompetitionEventV2,
  type CompetitionActor,
  type CompetitionEventStatus,
  type CompetitionEventV2,
  type CompetitionLedgerView,
  type MatchStartedV2,
} from "./competition-ledger-v2";
import {
  challengeCancelledFeedback,
  challengeJoinedFeedback,
  challengeOpenedFeedback,
  matchStartedFeedback,
  matchResultFeedback,
  rematchRequestedFeedback,
  practiceRecordFeedback,
  projectChatUpdate,
  tournamentSummary,
  type ChatUpdateMetadata,
} from "./chat-feedback";
import {
  PendingChatFeedbackStoreV2,
  type PendingChatFeedbackV2,
} from "./pending-chat-feedback";
import { connectionLossFallbackFor } from "./live-session-recovery";

const STORAGE_SCHEMA = "split-stack/competition-intents/v1" as const;
const STORAGE_KEY_PREFIX = `${STORAGE_SCHEMA}:`;
const DERIVED_STORAGE_SCHEMA = "split-stack/competition-derived/v1" as const;
const DERIVED_STORAGE_KEY_PREFIX = `${DERIVED_STORAGE_SCHEMA}:`;
const DURABLE_RETRY_MIN_MS = 1_000;
const DURABLE_RETRY_MAX_MS = 10_000;
const DURABLE_SUCCESS_SEND_LIMIT = 2;
const MAX_PENDING_INTENT_RECORDS = 64;
const TERMINAL_INTENT_RESERVE = 2;
const MAX_SETTLED_INTENT_HISTORY = 64;
const MAX_INTENT_STORAGE_CHARACTERS = 512_000;
const TERMINAL_INTENT_STORAGE_RESERVE_CHARACTERS = 64_000;
const MAX_REPLAYED_METADATA_PER_EVENT = 4;

declare const competitionIntentReferenceBrand: unique symbol;

export type CompetitionIntentReference = string & {
  readonly [competitionIntentReferenceBrand]: true;
};

export type CompetitionIntent =
  | { readonly kind: "create-challenge" }
  | { readonly kind: "join-challenge"; readonly challengeId: string }
  | { readonly kind: "cancel-challenge"; readonly challengeId: string }
  | {
      readonly kind: "set-readiness";
      readonly pairingId: string;
      readonly ready: boolean;
    }
  | { readonly kind: "leave-pairing"; readonly pairingId: string }
  | {
      readonly kind: "start-match";
      readonly pairingId: string;
      readonly seed: string;
    }
  | {
      readonly kind: "finish-match";
      readonly matchId: string;
      readonly result: CompetitionMatchCompletion;
    }
  | { readonly kind: "concede-match"; readonly matchId: string }
  | { readonly kind: "settle-connection-loss"; readonly matchId: string }
  | { readonly kind: "request-rematch"; readonly afterMatchId: string }
  | { readonly kind: "accept-rematch"; readonly afterMatchId: string }
  | {
      readonly kind: "complete-practice";
      readonly runId: string;
      readonly durationTicks: number;
      readonly finalLevel: number;
      readonly finalStats: CompetitionPracticeCompletionStats;
    };

export type CompetitionMatchCompletion = Omit<
  MatchResultV1,
  "schema" | "matchId" | "seedHash" | "players"
>;

export type CompetitionPracticeCompletionStats = Omit<PlayerResultStats, "topOutTick">;

export type CompetitionLifecycleEventStatus = CompetitionEventStatus | "unconfirmed";
export type CompetitionLifecycleFeedbackStatus = "pending" | "confirmed" | "not-required";

export interface CompetitionIntentLifecycle {
  readonly reference: CompetitionIntentReference;
  readonly intent: CompetitionIntent;
  readonly eventStatus: CompetitionLifecycleEventStatus;
  readonly feedbackStatus: CompetitionLifecycleFeedbackStatus;
  readonly settled: boolean;
}

export type CompetitionMatchStartView = Omit<
  MatchStartedV2,
  "schema" | "eventId" | "logicalClock" | "actor"
>;

export type CompetitionLiveMatchView = Omit<
  CompetitionLedgerView["liveMatches"][number],
  "startedEventId" | "start"
> & {
  readonly start: CompetitionMatchStartView;
};

export type CompetitionPendingRematchView = Omit<
  CompetitionLedgerView["pendingRematches"][number],
  "requestEventIdByPlayer"
>;

export type CompetitionRejectedClaimView = Omit<
  CompetitionLedgerView["rejectedClaims"][number],
  "claimEventId"
>;

export type CompetitionPracticeEntryView = Omit<
  NonNullable<CompetitionLedgerView["practice"]["record"]>,
  "eventId"
>;

export type CompetitionView = Omit<
  CompetitionLedgerView,
  "liveMatches" | "pendingRematches" | "rejectedClaims" | "practice"
> & {
  readonly liveMatches: readonly CompetitionLiveMatchView[];
  readonly pendingRematches: readonly CompetitionPendingRematchView[];
  readonly rejectedClaims: readonly CompetitionRejectedClaimView[];
  readonly practice: Omit<
    CompetitionLedgerView["practice"],
    "leaderboard" | "pinned" | "personalBest" | "record"
  > & {
    readonly leaderboard: readonly CompetitionPracticeEntryView[];
    readonly pinned: CompetitionPracticeEntryView | null;
    readonly personalBest: CompetitionPracticeEntryView | null;
    readonly record: CompetitionPracticeEntryView | null;
  };
};

export interface CompetitionLifecycleSnapshot {
  readonly revision: number;
  readonly competition: CompetitionView;
  readonly intents: readonly CompetitionIntentLifecycle[];
}

export type CompetitionLifecycleObserver = (
  snapshot: CompetitionLifecycleSnapshot,
) => void | Promise<void>;

export interface CompetitionEventLifecycle {
  express(intent: CompetitionIntent): CompetitionIntentReference;
  current(): CompetitionLifecycleSnapshot;
  observe(observer: CompetitionLifecycleObserver): () => void;
}

export interface CompetitionLifecycleScheduler {
  now(): number;
  setTimeout(task: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface CompetitionEventLifecycleOptions {
  readonly actor: CompetitionActor;
  readonly runtimeSessionId: string;
  readonly currentRulesHash: string;
  readonly host: DurableWebxdcHost<unknown> | null;
  readonly storage: StoragePort;
  readonly scheduler: CompetitionLifecycleScheduler;
  readonly createId: () => string;
}

interface PersistedIntentRecord {
  readonly schema: typeof STORAGE_SCHEMA;
  readonly reference: CompetitionIntentReference;
  readonly intent: CompetitionIntent;
  readonly payload: CompetitionEventV2;
  readonly feedbackContext?:
    | {
        readonly kind: "challenge-joined";
        readonly creatorId: string;
      }
    | {
        readonly kind: "pairing-left";
        readonly source: "challenge" | "rematch";
        readonly seatALeft: boolean;
        readonly challengeId: string;
        readonly actorName: string;
      }
    | {
        readonly kind: "match-started";
        readonly seatAName: string;
        readonly seatBName: string;
      }
    | {
        readonly kind: "rematch-requested";
        readonly opponentId: string;
      }
    | {
        readonly kind: "practice-record";
        readonly previousRecord: number;
      };
  feedbackPrepared: boolean;
  feedbackMetadata?: ChatUpdateMetadata;
  eventStatus: CompetitionLifecycleEventStatus;
  feedbackStatus: CompetitionLifecycleFeedbackStatus;
  settled: boolean;
}

interface DurableOutboxEntry {
  readonly update: DurableOutboundUpdate<CompetitionEventV2>;
  readonly successfulSendLimit: number;
  attempts: number;
  successfulSends: number;
  metadataDelivered: boolean;
  sending: boolean;
  retryTimer: number | null;
}

interface PersistedDerivedEvent {
  readonly schema: typeof DERIVED_STORAGE_SCHEMA;
  readonly key: string;
  readonly payload: CompetitionEventV2;
}

interface RuntimeClaimRepairState {
  readonly pairingId: string;
  readonly eventId: string;
  attempts: number;
  retryTimer: number | null;
  observedPeerRuntime: string | undefined;
}

interface ObserverState {
  active: boolean;
  delivery: Promise<void>;
}

interface ObserverSubscription {
  readonly observer: CompetitionLifecycleObserver;
  readonly state: ObserverState;
}

interface PendingDurableAppend {
  readonly update: DurableOutboundUpdate<CompetitionEventV2>;
  readonly owner: DurableOutboxEntry;
  readonly terminal: boolean;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

type OutboxAcknowledgement = "none" | "payload" | "feedback";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertLifecycleActor(value: unknown): CompetitionActor {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !("id" in value) ||
    !("displayName" in value)
  ) {
    throw new TypeError(
      "Competition actor must contain exactly the id and displayName properties",
    );
  }
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256) {
    throw new RangeError("Competition actor id must contain 1-256 characters");
  }
  if (
    typeof value.displayName !== "string" ||
    value.displayName.length < 1 ||
    value.displayName.length > 128
  ) {
    throw new RangeError("Competition actor display name must contain 1-128 characters");
  }
  return { id: value.id, displayName: value.displayName };
}

function assertRuntimeSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new RangeError("Competition runtime session id must contain 1-128 characters");
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function omitProperties<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const copied = clone(value) as T & Record<PropertyKey, unknown>;
  for (const key of keys) delete copied[key];
  return copied;
}

function projectCompetitionView(view: CompetitionLedgerView): CompetitionView {
  const practiceEntry = (
    entry: CompetitionLedgerView["practice"]["record"],
  ): CompetitionPracticeEntryView | null =>
    entry === null ? null : omitProperties(entry, ["eventId"]);
  return {
    ...clone(view),
    liveMatches: view.liveMatches.map((match) => ({
      ...omitProperties(match, ["startedEventId", "start"]),
      start: omitProperties(match.start, ["schema", "eventId", "logicalClock", "actor"]),
    })),
    pendingRematches: view.pendingRematches.map((rematch) =>
      omitProperties(rematch, ["requestEventIdByPlayer"])
    ),
    rejectedClaims: view.rejectedClaims.map((claim) =>
      omitProperties(claim, ["claimEventId"])
    ),
    practice: {
      ...omitProperties(view.practice, ["leaderboard", "pinned", "personalBest", "record"]),
      leaderboard: view.practice.leaderboard.map((entry) =>
        omitProperties(entry, ["eventId"])
      ),
      pinned: practiceEntry(view.practice.pinned),
      personalBest: practiceEntry(view.practice.personalBest),
      record: practiceEntry(view.practice.record),
    },
  };
}

function metadataMatches(
  expected: DurableOutboundUpdate<CompetitionEventV2>,
  received: DurableReceivedUpdate<unknown>,
): boolean {
  const expectsMetadata = expected.info !== undefined ||
    expected.href !== undefined ||
    expected.summary !== undefined ||
    expected.notify !== undefined;
  if (!expectsMetadata) return true;
  try {
    return expected.info === received.info &&
      expected.href === received.href &&
      expected.summary === received.summary &&
      canonicalize(expected.notify ?? null) === canonicalize(received.notify ?? null);
  } catch {
    return false;
  }
}

function eventRequiresFeedback(payload: CompetitionEventV2): boolean {
  return payload.kind !== "runtime-claimed" &&
    payload.kind !== "ready-changed" &&
    payload.kind !== "rematch-accepted" &&
    payload.kind !== "rematch-withdrawn";
}

function isTerminalIntentPayload(payload: CompetitionEventV2): boolean {
  return payload.kind === "match-finished" || payload.kind === "match-conceded";
}

function carriesChatMetadata(update: DurableOutboundUpdate<CompetitionEventV2>): boolean {
  return update.info !== undefined ||
    update.href !== undefined ||
    update.summary !== undefined ||
    update.notify !== undefined;
}

function competitionIdentifiers(payload: CompetitionEventV2): readonly string[] {
  const identifiers = new Set<string>();
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (key === "id" || key === "completedBy" || key.endsWith("Id")) {
        identifiers.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      if (key.endsWith("Ids")) {
        for (const entry of value) {
          if (typeof entry === "string") identifiers.add(entry);
        }
      }
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(payload);
  return [...identifiers];
}

function isPersistedFeedbackMetadata(value: unknown): value is ChatUpdateMetadata {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["href", "info", "notify", "summary"].includes(key))) {
    return false;
  }
  if (
    typeof value.summary !== "string" ||
    value.summary.length === 0 ||
    value.summary.length > 20
  ) {
    return false;
  }
  if (
    value.info !== undefined &&
    (typeof value.info !== "string" || value.info.length === 0 || value.info.length > 50)
  ) {
    return false;
  }
  if (
    value.href !== undefined &&
    (typeof value.href !== "string" || value.href.length === 0 || value.href.length > 1_024)
  ) {
    return false;
  }
  if (value.notify === undefined) return true;
  if (!isRecord(value.notify) || Object.keys(value.notify).length > 4) return false;
  return Object.entries(value.notify).every(([id, message]) =>
    id.length > 0 &&
    id.length <= 256 &&
    typeof message === "string" &&
    message.length > 0 &&
    message.length <= 50
  );
}

function intentForPayload(payload: CompetitionEventV2): CompetitionIntent | null {
  if (payload.kind === "challenge-created") return { kind: "create-challenge" };
  if (payload.kind === "challenge-claimed") {
    return { kind: "join-challenge", challengeId: payload.challengeId };
  }
  if (payload.kind === "challenge-cancelled") {
    return { kind: "cancel-challenge", challengeId: payload.challengeId };
  }
  if (payload.kind === "ready-changed") {
    return { kind: "set-readiness", pairingId: payload.pairingId, ready: payload.ready };
  }
  if (payload.kind === "pairing-left") {
    return { kind: "leave-pairing", pairingId: payload.pairingId };
  }
  if (payload.kind === "match-started") {
    return { kind: "start-match", pairingId: payload.pairingId, seed: payload.seed };
  }
  if (payload.kind === "match-finished") {
    const deterministicConnectionLossId = `connection-lost:${hashCanonicalHex({
      startedEventId: payload.startedEventId,
      actorId: payload.actor.id,
    })}`;
    if (
      payload.result.reason === "connection-lost" &&
      payload.eventId === deterministicConnectionLossId
    ) {
      return { kind: "settle-connection-loss", matchId: payload.matchId };
    }
    return {
      kind: "finish-match",
      matchId: payload.matchId,
      result: {
        outcome: payload.result.outcome,
        reason: payload.result.reason,
        durationTicks: payload.result.durationTicks,
        finalLevel: payload.result.finalLevel,
        statsByPlayer: clone(payload.result.statsByPlayer),
        completedBy: payload.result.completedBy,
      },
    };
  }
  if (payload.kind === "match-conceded") {
    return { kind: "concede-match", matchId: payload.matchId };
  }
  if (payload.kind === "rematch-requested") {
    return { kind: "request-rematch", afterMatchId: payload.afterMatchId };
  }
  if (payload.kind === "rematch-accepted") {
    return { kind: "accept-rematch", afterMatchId: payload.afterMatchId };
  }
  if (payload.kind === "practice-completed") {
    return {
      kind: "complete-practice",
      runId: payload.runId,
      durationTicks: payload.durationTicks,
      finalLevel: payload.finalLevel,
      finalStats: {
        score: payload.finalStats.score,
        lines: payload.finalStats.lines,
        garbageSent: payload.finalStats.garbageSent,
        powersActivated: payload.finalStats.powersActivated,
        tetrises: payload.finalStats.tetrises,
        tSpinSingles: payload.finalStats.tSpinSingles,
        tSpinDoubles: payload.finalStats.tSpinDoubles,
        tSpinTriples: payload.finalStats.tSpinTriples,
      },
    };
  }
  return null;
}

function intentExactlyMatchesPayload(
  value: unknown,
  payload: CompetitionEventV2,
): value is CompetitionIntent {
  const expected = intentForPayload(payload);
  if (expected === null) return false;
  try {
    return canonicalize(value) === canonicalize(expected);
  } catch {
    return false;
  }
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isBoundedRecoveryString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function feedbackContextMatchesPayload(
  context: unknown,
  payload: CompetitionEventV2,
): boolean {
  if (payload.kind === "challenge-claimed") {
    return isRecord(context) &&
      hasExactKeys(context, ["kind", "creatorId"]) &&
      context.kind === "challenge-joined" &&
      isBoundedRecoveryString(context.creatorId, 256) &&
      context.creatorId !== payload.actor.id;
  }
  if (payload.kind === "pairing-left") {
    return isRecord(context) &&
      hasExactKeys(context, ["kind", "source", "seatALeft", "challengeId", "actorName"]) &&
      context.kind === "pairing-left" &&
      (context.source === "challenge" || context.source === "rematch") &&
      typeof context.seatALeft === "boolean" &&
      isBoundedRecoveryString(context.challengeId, 256) &&
      context.actorName === payload.actor.displayName;
  }
  if (payload.kind === "match-started") {
    return isRecord(context) &&
      hasExactKeys(context, ["kind", "seatAName", "seatBName"]) &&
      context.kind === "match-started" &&
      isBoundedRecoveryString(context.seatAName, 128) &&
      isBoundedRecoveryString(context.seatBName, 128);
  }
  if (payload.kind === "rematch-requested") {
    return isRecord(context) &&
      hasExactKeys(context, ["kind", "opponentId"]) &&
      context.kind === "rematch-requested" &&
      isBoundedRecoveryString(context.opponentId, 256) &&
      context.opponentId !== payload.actor.id;
  }
  if (payload.kind === "practice-completed") {
    return isRecord(context) &&
      hasExactKeys(context, ["kind", "previousRecord"]) &&
      context.kind === "practice-record" &&
      Number.isSafeInteger(context.previousRecord) &&
      (context.previousRecord as number) >= 0;
  }
  return context === undefined;
}

function isPersistedIntentRecord(value: unknown, actorId: string): value is PersistedIntentRecord {
  if (!isRecord(value)) return false;
  if (!isCompetitionEventV2(value.payload)) return false;
  return value.schema === STORAGE_SCHEMA &&
    typeof value.reference === "string" &&
    value.reference.length > 0 &&
    value.reference.length <= 256 &&
    value.reference !== value.payload.eventId &&
    intentExactlyMatchesPayload(value.intent, value.payload) &&
    feedbackContextMatchesPayload(value.feedbackContext, value.payload) &&
    value.payload.actor.id === actorId &&
    ["unconfirmed", "unknown", "deferred", "effective", "rejected"].includes(
      String(value.eventStatus),
    ) &&
    ["pending", "confirmed", "not-required"].includes(String(value.feedbackStatus)) &&
    (value.feedbackPrepared === undefined || typeof value.feedbackPrepared === "boolean") &&
    (value.feedbackMetadata === undefined || isPersistedFeedbackMetadata(value.feedbackMetadata)) &&
    (value.feedbackStatus !== "not-required" || value.feedbackMetadata === undefined) &&
    typeof value.settled === "boolean";
}

class CompetitionEventLifecycleImplementation {
  private readonly actor: CompetitionActor;
  private readonly runtimeSessionId: string;
  private readonly currentRulesHash: string;
  private readonly host: DurableWebxdcHost<unknown> | null;
  private readonly storage: StoragePort;
  private readonly scheduler: CompetitionLifecycleScheduler;
  private readonly createId: () => string;
  private readonly durable: WebxdcDurableLog<unknown> | null;
  private readonly clock = new DurableLamportClock();
  private readonly ledger: CompetitionLedgerV2;
  private readonly feedback: PendingChatFeedbackStoreV2;
  private readonly recordsByReference = new Map<CompetitionIntentReference, PersistedIntentRecord>();
  private readonly referenceByEventId = new Map<string, CompetitionIntentReference>();
  private readonly durableOutbox = new Map<string, DurableOutboxEntry>();
  private readonly derivedByKey = new Map<string, PersistedDerivedEvent>();
  private readonly runtimeClaimRepairs = new Map<string, RuntimeClaimRepairState>();
  private readonly usedPrivateIds = new Set<string>();
  private readonly claimedIntentStoreEventIds = new Set<string>();
  private readonly replayedMetadataByEventId = new Map<
    string,
    DurableReceivedUpdate<unknown>[]
  >();
  private readonly observers = new Set<ObserverSubscription>();
  private readonly storageKey: string;
  private readonly derivedStorageKey: string;
  private readonly appendQueue: PendingDurableAppend[] = [];
  private appendRunning = false;
  private lastAppendMs = Number.NEGATIVE_INFINITY;
  private replayReady = false;
  private legacyAdoptionAllowed = false;
  private revision = 0;
  private snapshot: CompetitionLifecycleSnapshot;

  public constructor(options: CompetitionEventLifecycleOptions) {
    this.actor = assertLifecycleActor(options.actor);
    this.runtimeSessionId = assertRuntimeSessionId(options.runtimeSessionId);
    this.currentRulesHash = options.currentRulesHash;
    this.host = options.host;
    this.storage = options.storage;
    this.scheduler = options.scheduler;
    this.createId = options.createId;
    this.usedPrivateIds.add(options.actor.id);
    this.usedPrivateIds.add(options.runtimeSessionId);
    this.durable = options.host === null ? null : new WebxdcDurableLog(options.host);
    this.ledger = new CompetitionLedgerV2({ currentRulesHash: options.currentRulesHash });
    this.feedback = new PendingChatFeedbackStoreV2(
      options.storage,
      options.currentRulesHash,
      options.actor.id,
    );
    this.storageKey = `${STORAGE_KEY_PREFIX}${options.currentRulesHash}:${options.actor.id}`;
    this.derivedStorageKey =
      `${DERIVED_STORAGE_KEY_PREFIX}${options.currentRulesHash}:${options.actor.id}`;
    if (this.durable !== null) {
      this.loadRecords();
      this.loadDerivedEvents();
      this.adoptLegacyFeedbackEntries();
    }
    this.snapshot = this.buildSnapshot();
  }

  public async start(): Promise<void> {
    if (this.durable !== null) {
      await this.durable.start((update) => this.receive(update), 0);
      this.replayReady = true;
      this.reconcileMaterializationChanges();
      for (const record of this.recordsByReference.values()) {
        const status = this.ledger.eventStatus(record.payload.eventId);
        const pendingFeedback = this.feedback.get(record.payload.eventId);
        if (status === "unknown") {
          this.enqueue({ payload: record.payload });
        } else if (
          status === "effective" &&
          record.feedbackStatus !== "confirmed" &&
          !this.durableOutbox.has(record.payload.eventId)
        ) {
          const metadata = record.feedbackMetadata ?? (
            pendingFeedback?.resolved === true ? pendingFeedback.metadata : undefined
          );
          if (metadata !== undefined) {
            record.feedbackPrepared = true;
            record.feedbackMetadata = clone(metadata);
            this.enqueue(projectChatUpdate(record.payload, metadata));
          }
        }
      }
      for (const derived of this.derivedByKey.values()) {
        if (this.ledger.eventStatus(derived.payload.eventId) === "unknown") {
          this.enqueue({ payload: derived.payload });
        }
      }
      this.syncRuntimeClaim();
      this.pruneReplayMetadataCandidates();
    } else {
      this.replayReady = true;
    }
    this.refresh(false);
  }

  public interface(): CompetitionEventLifecycle {
    return {
      express: (intent) => this.express(intent),
      current: () => this.snapshot,
      observe: (observer) => this.observe(observer),
    };
  }

  private express(intent: CompetitionIntent): CompetitionIntentReference {
    if (this.durable === null) {
      throw new Error("Competition Intent requires a durable host");
    }
    if (!isRecord(intent)) throw new TypeError("Unsupported Competition Intent");
    if (intent.kind === "concede-match") {
      const matchId = this.boundedId(intent.matchId, "match ID", 256);
      const existingAdmission = [...this.recordsByReference.entries()].find(([, record]) =>
        !record.settled &&
        record.intent.kind === "concede-match" &&
        record.intent.matchId === matchId
      );
      if (existingAdmission !== undefined) {
        const [existingReference, existing] = existingAdmission;
        if (
          existing.payload.kind !== "match-conceded" ||
          existing.payload.matchId !== matchId ||
          existing.payload.actor.id !== this.actor.id
        ) {
          throw new Error("Concession identity collision");
        }
        this.reassert(existing);
        return existingReference;
      }
    }
    let connectionLossAdmission: {
      readonly matchId: string;
      readonly payload: CompetitionEventV2;
    } | undefined;
    if (intent.kind === "settle-connection-loss") {
      const matchId = this.boundedId(intent.matchId, "match ID", 256);
      const existingAdmission = [...this.recordsByReference.entries()].find(([, record]) =>
        record.intent.kind === "settle-connection-loss" && record.intent.matchId === matchId
      );
      if (existingAdmission !== undefined) {
        const [existingReference, existing] = existingAdmission;
        if (
          existing.payload.kind !== "match-finished" ||
          existing.payload.matchId !== matchId ||
          existing.payload.result.reason !== "connection-lost" ||
          existing.payload.eventId !== `connection-lost:${hashCanonicalHex({
            startedEventId: existing.payload.startedEventId,
            actorId: this.actor.id,
          })}`
        ) {
          throw new Error("Deterministic connection-loss identity collision");
        }
        this.reassert(existing);
        return existingReference;
      }
      const live = this.ledger.view(this.actor.id).liveMatches.find(
        (candidate) => candidate.matchId === matchId &&
          (candidate.seatA.id === this.actor.id || candidate.seatB.id === this.actor.id),
      );
      if (live === undefined) {
        throw new RangeError("The target match cannot be settled by this player");
      }
      const payload = connectionLossFallbackFor(live, this.actor);
      const existingReference = this.referenceByEventId.get(payload.eventId);
      if (existingReference !== undefined) {
        const existing = this.recordsByReference.get(existingReference);
        if (
          existing?.intent.kind !== "settle-connection-loss" ||
          existing.intent.matchId !== matchId ||
          canonicalize(existing.payload) !== canonicalize(payload)
        ) {
          throw new Error("Deterministic connection-loss identity collision");
        }
        this.reassert(existing);
        return existingReference;
      }
      if (
        this.usedPrivateIds.has(payload.eventId) ||
        [...this.derivedByKey.values()].some(
          (derived) => derived.payload.eventId === payload.eventId,
        )
      ) {
        throw new Error("Deterministic connection-loss identity collision");
      }
      connectionLossAdmission = { matchId, payload };
    }
    const logicalClock = connectionLossAdmission?.payload.logicalClock ?? this.clock.next();
    const eventId = connectionLossAdmission?.payload.eventId ??
      this.freshPrivateId("Competition Event ID");
    const reference = this.freshPrivateId(
      "Competition Intent Reference",
      [eventId],
    ) as CompetitionIntentReference;
    let admittedIntent: CompetitionIntent;
    let payload: CompetitionEventV2;
    let feedbackContext: PersistedIntentRecord["feedbackContext"];
    if (intent.kind === "create-challenge") {
      const challengeId = this.freshPrivateId("challenge ID", [eventId, reference]);
      const vacancyId = this.freshPrivateId(
        "vacancy ID",
        [eventId, reference, challengeId],
      );
      admittedIntent = { kind: "create-challenge" };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "challenge-created",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        challengeId,
        rulesHash: this.currentRulesHash,
        vacancyId,
      };
    } else if (intent.kind === "join-challenge") {
      const challengeId = this.boundedId(intent.challengeId, "challenge ID", 256);
      const challenge = this.ledger.view(this.actor.id).openChallenges.find(
        (candidate) => candidate.challengeId === challengeId,
      );
      if (challenge === undefined || challenge.creator.id === this.actor.id) {
        throw new RangeError("The target challenge is not joinable");
      }
      admittedIntent = { kind: "join-challenge", challengeId };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "challenge-claimed",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        challengeId,
        vacancyId: challenge.vacancyId,
      };
      feedbackContext = { kind: "challenge-joined", creatorId: challenge.creator.id };
    } else if (intent.kind === "cancel-challenge") {
      const challengeId = this.boundedId(intent.challengeId, "challenge ID", 256);
      const challenge = this.ledger.view(this.actor.id).openChallenges.find(
        (candidate) => candidate.challengeId === challengeId,
      );
      if (challenge === undefined || challenge.creator.id !== this.actor.id) {
        throw new RangeError("The target challenge cannot be cancelled by this player");
      }
      admittedIntent = { kind: "cancel-challenge", challengeId };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "challenge-cancelled",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        challengeId,
      };
    } else if (intent.kind === "set-readiness") {
      const pairingId = this.boundedId(intent.pairingId, "pairing ID", 256);
      const pairing = this.ledger.view(this.actor.id).startingPairings.find(
        (candidate) => candidate.pairingId === pairingId &&
          (candidate.seatA.id === this.actor.id || candidate.seatB.id === this.actor.id),
      );
      if (pairing?.runtimeSessionByPlayer[this.actor.id] !== this.runtimeSessionId) {
        throw new RangeError("The target pairing is not controlled by this runtime");
      }
      admittedIntent = { kind: "set-readiness", pairingId, ready: intent.ready };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "ready-changed",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        pairingId,
        runtimeSessionId: this.runtimeSessionId,
        ready: intent.ready,
      };
    } else if (intent.kind === "leave-pairing") {
      const pairingId = this.boundedId(intent.pairingId, "pairing ID", 256);
      const pairing = this.ledger.view(this.actor.id).startingPairings.find(
        (candidate) => candidate.pairingId === pairingId &&
          (candidate.seatA.id === this.actor.id || candidate.seatB.id === this.actor.id),
      );
      if (pairing === undefined) {
        throw new RangeError("The target pairing cannot be left by this player");
      }
      admittedIntent = { kind: "leave-pairing", pairingId };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "pairing-left",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        pairingId,
        runtimeSessionId: this.runtimeSessionId,
      };
      feedbackContext = {
        kind: "pairing-left",
        source: pairing.source,
        seatALeft: pairing.seatA.id === this.actor.id,
        challengeId: pairing.seriesId,
        actorName: this.actor.displayName,
      };
    } else if (intent.kind === "start-match") {
      const pairingId = this.boundedId(intent.pairingId, "pairing ID", 256);
      const seed = this.boundedId(intent.seed, "match seed", 256);
      if (!/^[0-9a-f]{32}$/u.test(seed)) {
        throw new RangeError("Match seed must be a 128-bit lowercase hexadecimal token");
      }
      const pairing = this.ledger.view(this.actor.id).startingPairings.find(
        (candidate) => candidate.pairingId === pairingId,
      );
      if (pairing === undefined || pairing.seatA.id !== this.actor.id) {
        throw new RangeError("Only Seat A may start the target pairing");
      }
      const seatASessionId = pairing.runtimeSessionByPlayer[pairing.seatA.id];
      const seatBSessionId = pairing.runtimeSessionByPlayer[pairing.seatB.id];
      if (
        seatASessionId !== this.runtimeSessionId ||
        seatBSessionId === undefined
      ) {
        throw new RangeError("Both runtime claims must be canonical before match start");
      }
      admittedIntent = { kind: "start-match", pairingId, seed };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "match-started",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        pairingId,
        seriesId: pairing.seriesId,
        round: pairing.round,
        matchId: pairing.matchId,
        rulesHash: this.currentRulesHash,
        configHash: hashCanonicalHex({
          rulesVersion: RULES.rulesVersion,
          rulesHash: this.currentRulesHash,
          seed,
          seatAPlayerId: pairing.seatA.id,
          seatBPlayerId: pairing.seatB.id,
        }),
        seed,
        seedHash: hashCanonicalHex({ seed }),
        seatAPlayerId: pairing.seatA.id,
        seatBPlayerId: pairing.seatB.id,
        seatASessionId,
        seatBSessionId,
      };
      feedbackContext = {
        kind: "match-started",
        seatAName: pairing.seatA.displayName,
        seatBName: pairing.seatB.displayName,
      };
    } else if (intent.kind === "finish-match") {
      const matchId = this.boundedId(intent.matchId, "match ID", 256);
      const match = this.matchContext(matchId);
      if (
        match === undefined ||
        (match.seatA.id !== this.actor.id && match.seatB.id !== this.actor.id)
      ) {
        throw new RangeError("The target match cannot be finished by this player");
      }
      const completion: CompetitionMatchCompletion = {
        outcome: intent.result.outcome,
        reason: intent.result.reason,
        durationTicks: intent.result.durationTicks,
        finalLevel: intent.result.finalLevel,
        statsByPlayer: clone(intent.result.statsByPlayer),
        completedBy: intent.result.completedBy,
      };
      admittedIntent = {
        kind: "finish-match",
        matchId,
        result: clone(completion),
      };
      const result: MatchResultV1 = {
        ...clone(completion),
        schema: "split-stack/result/v1",
        matchId,
        seedHash: match.start.seedHash,
        players: [clone(match.seatA), clone(match.seatB)],
      };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "match-finished",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        matchId,
        startedEventId: match.startedEventId,
        result,
      };
      if (!isCompetitionEventV2(payload)) {
        throw new TypeError("Match completion is not a valid canonical result");
      }
    } else if (intent.kind === "concede-match") {
      const matchId = this.boundedId(intent.matchId, "match ID", 256);
      const match = this.matchContext(matchId);
      if (
        match === undefined ||
        (match.seatA.id !== this.actor.id && match.seatB.id !== this.actor.id)
      ) {
        throw new RangeError("The target match cannot be conceded by this player");
      }
      admittedIntent = { kind: "concede-match", matchId };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "match-conceded",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        matchId,
        startedEventId: match.startedEventId,
      };
    } else if (intent.kind === "settle-connection-loss") {
      if (connectionLossAdmission === undefined) {
        throw new Error("Connection-loss admission was not derived");
      }
      admittedIntent = {
        kind: "settle-connection-loss",
        matchId: connectionLossAdmission.matchId,
      };
      payload = connectionLossAdmission.payload;
    } else if (intent.kind === "request-rematch") {
      const afterMatchId = this.boundedId(intent.afterMatchId, "match ID", 256);
      const view = this.ledger.view(this.actor.id);
      const result = view.recentResults.find((candidate) =>
        candidate.matchId === afterMatchId &&
        candidate.result.players.some((player) => player.id === this.actor.id)
      );
      const opponent = result?.result.players.find((player) => player.id !== this.actor.id);
      if (result === undefined || opponent === undefined || view.activity.kind !== "idle") {
        throw new RangeError("The target result cannot be rematched by this player");
      }
      admittedIntent = { kind: "request-rematch", afterMatchId };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "rematch-requested",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        seriesId: result.seriesId,
        afterMatchId,
        round: result.round + 1,
      };
      feedbackContext = { kind: "rematch-requested", opponentId: opponent.id };
    } else if (intent.kind === "accept-rematch") {
      const afterMatchId = this.boundedId(intent.afterMatchId, "match ID", 256);
      const view = this.ledger.view(this.actor.id);
      const pending = view.pendingRematches.find((candidate) =>
        candidate.afterMatchId === afterMatchId &&
        !candidate.requestedByPlayerIds.includes(this.actor.id) &&
        (candidate.seatA.id === this.actor.id || candidate.seatB.id === this.actor.id)
      );
      if (pending === undefined || view.activity.kind !== "idle") {
        throw new RangeError("The target rematch cannot be accepted by this player");
      }
      const opponent = pending.seatA.id === this.actor.id ? pending.seatB : pending.seatA;
      const requestedEventId = pending.requestEventIdByPlayer[opponent.id];
      if (requestedEventId === undefined) {
        throw new RangeError("The rematch request is not canonical");
      }
      admittedIntent = { kind: "accept-rematch", afterMatchId };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "rematch-accepted",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        seriesId: pending.seriesId,
        afterMatchId,
        round: pending.round,
        requestedEventId,
      };
    } else if (intent.kind === "complete-practice") {
      const runId = this.boundedId(intent.runId, "Practice run ID", 256);
      const finalStats: CompetitionPracticeCompletionStats = {
        score: intent.finalStats.score,
        lines: intent.finalStats.lines,
        garbageSent: intent.finalStats.garbageSent,
        powersActivated: intent.finalStats.powersActivated,
        tetrises: intent.finalStats.tetrises,
        tSpinSingles: intent.finalStats.tSpinSingles,
        tSpinDoubles: intent.finalStats.tSpinDoubles,
        tSpinTriples: intent.finalStats.tSpinTriples,
      };
      admittedIntent = {
        kind: "complete-practice",
        runId,
        durationTicks: intent.durationTicks,
        finalLevel: intent.finalLevel,
        finalStats: clone(finalStats),
      };
      payload = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "practice-completed",
        eventId,
        logicalClock,
        actor: clone(this.actor),
        rulesHash: this.currentRulesHash,
        runId,
        endReason: "top-out",
        score: finalStats.score,
        durationTicks: intent.durationTicks,
        finalLevel: intent.finalLevel,
        finalStats: {
          ...clone(finalStats),
          topOutTick: intent.durationTicks,
        },
      };
      if (!isCompetitionEventV2(payload)) {
        throw new TypeError("Practice completion is not a valid canonical record");
      }
      feedbackContext = {
        kind: "practice-record",
        previousRecord: this.ledger.view(this.actor.id).practice.record?.score ?? 0,
      };
    } else {
      throw new TypeError("Unsupported Competition Intent");
    }
    if (!isCompetitionEventV2(payload)) {
      throw new TypeError("Intent did not produce a valid Competition Event");
    }
    if (!this.hasIntentCapacity(payload)) {
      throw new RangeError("Competition Intent recovery capacity is full");
    }
    const record: PersistedIntentRecord = {
      schema: STORAGE_SCHEMA,
      reference,
      intent: admittedIntent,
      payload,
      ...(feedbackContext === undefined ? {} : { feedbackContext }),
      eventStatus: "unconfirmed",
      feedbackStatus: eventRequiresFeedback(payload) ? "pending" : "not-required",
      feedbackPrepared: false,
      settled: false,
    };
    this.recordsByReference.set(reference, record);
    this.referenceByEventId.set(payload.eventId, reference);
    this.reservePayloadIdentifiers(payload);
    try {
      this.persistRecords();
    } catch (error) {
      this.recordsByReference.delete(reference);
      this.referenceByEventId.delete(payload.eventId);
      throw error;
    }
    this.rememberFeedbackIntent(record);
    this.enqueue({ payload });
    this.refresh();
    return reference;
  }

  private observe(observer: CompetitionLifecycleObserver): () => void {
    if (typeof observer !== "function") throw new TypeError("Observer must be a function");
    const state: ObserverState = { active: true, delivery: Promise.resolve() };
    const subscription: ObserverSubscription = { observer, state };
    this.observers.add(subscription);
    this.deliver(observer, state, this.snapshot);
    return () => {
      state.active = false;
      this.observers.delete(subscription);
    };
  }

  private reassert(record: PersistedIntentRecord): void {
    if (this.durable === null || this.durableOutbox.has(record.payload.eventId)) return;
    const status = this.ledger.eventStatus(record.payload.eventId);
    if (status === "unknown") {
      this.enqueue({ payload: record.payload }, 1);
      return;
    }
    const pendingFeedback = this.feedback.get(record.payload.eventId);
    const metadata = record.feedbackMetadata ?? (
      pendingFeedback?.resolved === true ? pendingFeedback.metadata : undefined
    );
    if (
      record.feedbackStatus !== "confirmed" &&
      metadata !== undefined
    ) {
      this.enqueue(projectChatUpdate(record.payload, metadata), 1);
    }
  }

  private deliver(
    observer: CompetitionLifecycleObserver,
    state: ObserverState,
    snapshot: CompetitionLifecycleSnapshot,
  ): void {
    state.delivery = state.delivery
      .then(async () => {
        if (state.active) await observer(snapshot);
      })
      .catch(() => undefined);
  }

  private receive(update: DurableReceivedUpdate<unknown>): void {
    const { payload, serial } = update;
    if (!Number.isSafeInteger(serial) || serial < 1 || !isCompetitionEventV2(payload)) return;
    this.reservePayloadIdentifiers(payload);
    const before = this.ledger.view(this.actor.id);
    this.clock.observe(payload.logicalClock);
    this.ledger.apply({ serial, payload });
    const outboxAcknowledgement = this.acknowledgeOutbox(payload, update);
    const reference = this.referenceByEventId.get(payload.eventId);
    const record = reference === undefined ? undefined : this.recordsByReference.get(reference);
    if (!this.replayReady) {
      if (record !== undefined && this.ledger.hasCanonicalEvent(payload) &&
        canonicalize(record.payload) === canonicalize(payload)) {
        record.eventStatus = this.ledger.eventStatus(record.payload.eventId);
        const pending = this.feedback.get(record.payload.eventId);
        const feedbackReceipt = update.info !== undefined ||
          update.href !== undefined ||
          update.summary !== undefined ||
          update.notify !== undefined;
        const persistedMetadata = record.feedbackMetadata ?? (
          pending?.resolved === true ? pending.metadata : undefined
        );
        const historicalMetadata = persistedMetadata ?? (
          record.eventStatus === "effective"
            ? this.materializedFeedbackFor(record) ?? undefined
            : undefined
        );
        if (
          feedbackReceipt &&
          historicalMetadata !== undefined &&
          metadataMatches(projectChatUpdate(record.payload, historicalMetadata), update)
        ) {
          record.feedbackStatus = "confirmed";
          record.feedbackPrepared = true;
          record.feedbackMetadata = clone(historicalMetadata);
          record.settled = record.eventStatus === "effective" || record.eventStatus === "rejected";
          this.feedback.acknowledge(record.payload.eventId);
          this.replayedMetadataByEventId.delete(record.payload.eventId);
        } else if (feedbackReceipt) {
          const candidates = this.replayedMetadataByEventId.get(record.payload.eventId) ?? [];
          if (candidates.length >= MAX_REPLAYED_METADATA_PER_EVENT) candidates.shift();
          candidates.push(clone(update));
          this.replayedMetadataByEventId.set(record.payload.eventId, candidates);
        }
      }
      return;
    }
    if (record !== undefined) {
      this.receiveLocal(record, payload, update, before, outboxAcknowledgement);
    }
    this.reconcileMaterializationChanges();
    this.syncRuntimeClaim();
    this.refresh();
  }

  private syncRuntimeClaim(): void {
    if (this.durable === null || !this.replayReady) return;
    const pairing = this.ledger.view(this.actor.id).startingPairings.find(
      (candidate) => candidate.seatA.id === this.actor.id || candidate.seatB.id === this.actor.id,
    );
    this.pruneRuntimeClaims(pairing?.pairingId);
    if (pairing === undefined) return;
    const key = `runtime:${this.runtimeSessionId}:${pairing.pairingId}`;
    let derived = this.derivedByKey.get(key);
    if (derived === undefined) {
      const payload: CompetitionEventV2 = {
        schema: COMPETITION_EVENT_SCHEMA_V2,
        kind: "runtime-claimed",
        eventId: this.freshPrivateId("Competition Event ID"),
        logicalClock: this.clock.next(),
        actor: clone(this.actor),
        pairingId: pairing.pairingId,
        runtimeSessionId: this.runtimeSessionId,
      };
      derived = { schema: DERIVED_STORAGE_SCHEMA, key, payload };
      this.derivedByKey.set(key, derived);
      try {
        this.persistDerivedEvents();
      } catch {
        this.derivedByKey.delete(key);
        return;
      }
    }
    let repair = this.runtimeClaimRepairs.get(pairing.pairingId);
    if (repair === undefined || repair.eventId !== derived.payload.eventId) {
      if (repair?.retryTimer !== null && repair?.retryTimer !== undefined) {
        this.scheduler.clearTimeout(repair.retryTimer);
      }
      repair = {
        pairingId: pairing.pairingId,
        eventId: derived.payload.eventId,
        attempts: 0,
        retryTimer: null,
        observedPeerRuntime: undefined,
      };
      this.runtimeClaimRepairs.set(pairing.pairingId, repair);
    }
    const status = this.ledger.eventStatus(derived.payload.eventId);
    if (status === "unknown") {
      if (!this.durableOutbox.has(derived.payload.eventId)) {
        this.enqueue({ payload: derived.payload });
      }
      return;
    }
    const localRuntime = pairing.runtimeSessionByPlayer[this.actor.id];
    if (status !== "effective" || localRuntime !== this.runtimeSessionId) {
      this.cancelRuntimeClaimRepair(repair);
      return;
    }
    const peer = pairing.seatA.id === this.actor.id ? pairing.seatB : pairing.seatA;
    const peerRuntime = pairing.runtimeSessionByPlayer[peer.id];
    if (peerRuntime === undefined) {
      repair.observedPeerRuntime = undefined;
      this.scheduleRuntimeClaimRepair(derived, repair);
      return;
    }
    this.cancelRuntimeClaimRepair(repair);
    if (repair.observedPeerRuntime !== peerRuntime) {
      repair.observedPeerRuntime = peerRuntime;
      if (!this.durableOutbox.has(derived.payload.eventId)) {
        this.enqueue({ payload: derived.payload }, 1);
      }
    }
  }

  private scheduleRuntimeClaimRepair(
    derived: PersistedDerivedEvent,
    repair: RuntimeClaimRepairState,
  ): void {
    if (repair.retryTimer !== null) return;
    const delayMs = Math.max(
      Math.max(0, this.host?.sendUpdateInterval ?? 0),
      Math.min(
        DURABLE_RETRY_MAX_MS,
        DURABLE_RETRY_MIN_MS * 2 ** Math.min(repair.attempts, 4),
      ),
    );
    repair.retryTimer = this.scheduler.setTimeout(() => {
      repair.retryTimer = null;
      if (this.runtimeClaimRepairs.get(repair.pairingId) !== repair) return;
      const pairing = this.ledger.view(this.actor.id).startingPairings.find(
        (candidate) => candidate.pairingId === repair.pairingId,
      );
      if (pairing === undefined) {
        this.syncRuntimeClaim();
        return;
      }
      const peer = pairing.seatA.id === this.actor.id ? pairing.seatB : pairing.seatA;
      if (
        pairing.runtimeSessionByPlayer[this.actor.id] !== this.runtimeSessionId ||
        pairing.runtimeSessionByPlayer[peer.id] !== undefined
      ) {
        this.syncRuntimeClaim();
        return;
      }
      if (!this.durableOutbox.has(derived.payload.eventId)) {
        this.enqueue({ payload: derived.payload }, 1);
        repair.attempts += 1;
      }
      this.scheduleRuntimeClaimRepair(derived, repair);
    }, delayMs);
  }

  private cancelRuntimeClaimRepair(repair: RuntimeClaimRepairState): void {
    if (repair.retryTimer !== null) this.scheduler.clearTimeout(repair.retryTimer);
    repair.retryTimer = null;
    repair.attempts = 0;
  }

  private pruneRuntimeClaims(activePairingId: string | undefined): void {
    let changed = false;
    for (const [pairingId, repair] of this.runtimeClaimRepairs) {
      if (pairingId === activePairingId) continue;
      this.cancelRuntimeClaimRepair(repair);
      this.runtimeClaimRepairs.delete(pairingId);
    }
    for (const [key, derived] of this.derivedByKey) {
      if (derived.payload.kind !== "runtime-claimed") continue;
      if (derived.payload.pairingId === activePairingId) continue;
      const outbox = this.durableOutbox.get(derived.payload.eventId);
      if (outbox?.retryTimer !== null && outbox?.retryTimer !== undefined) {
        this.scheduler.clearTimeout(outbox.retryTimer);
      }
      this.durableOutbox.delete(derived.payload.eventId);
      this.derivedByKey.delete(key);
      changed = true;
    }
    if (!changed) return;
    try {
      this.persistDerivedEvents();
    } catch {
      // Derived recovery is best effort once its pairing is no longer active.
    }
  }

  private matchContext(matchId: string): {
    readonly start: MatchStartedV2;
    readonly startedEventId: string;
    readonly seatA: CompetitionActor;
    readonly seatB: CompetitionActor;
  } | undefined {
    const view = this.ledger.view(this.actor.id);
    const live = view.liveMatches.find((candidate) => candidate.matchId === matchId);
    if (live !== undefined) {
      return {
        start: live.start,
        startedEventId: live.startedEventId,
        seatA: live.seatA,
        seatB: live.seatB,
      };
    }
    const start = this.ledger.deferredMatchStart(matchId);
    if (start === undefined) return undefined;
    const pairing = view.startingPairings.find(
      (candidate) => candidate.pairingId === start.pairingId,
    );
    if (pairing === undefined) return undefined;
    return {
      start,
      startedEventId: start.eventId,
      seatA: pairing.seatA,
      seatB: pairing.seatB,
    };
  }

  private receiveLocal(
    record: PersistedIntentRecord,
    payload: CompetitionEventV2,
    update: DurableReceivedUpdate<unknown>,
    before: CompetitionLedgerView,
    outboxAcknowledgement: OutboxAcknowledgement,
  ): void {
    if (canonicalize(record.payload) !== canonicalize(payload)) return;
    if (!this.ledger.hasCanonicalEvent(record.payload)) return;
    const feedbackReceipt = update.info !== undefined ||
      update.href !== undefined ||
      update.summary !== undefined ||
      update.notify !== undefined;
    if (feedbackReceipt) {
      const pending = this.feedback.get(record.payload.eventId);
      const matchesPersistedFeedback = pending?.resolved === true &&
        pending.metadata !== undefined &&
        metadataMatches(projectChatUpdate(record.payload, pending.metadata), update);
      const matchesPrimaryFeedback = record.feedbackMetadata !== undefined &&
        metadataMatches(projectChatUpdate(record.payload, record.feedbackMetadata), update);
      if (
        outboxAcknowledgement === "feedback" ||
        matchesPrimaryFeedback ||
        matchesPersistedFeedback
      ) {
        this.feedback.acknowledge(record.payload.eventId);
        record.eventStatus = this.ledger.eventStatus(record.payload.eventId);
        record.feedbackStatus = "confirmed";
        record.feedbackPrepared = true;
        if (record.feedbackMetadata === undefined && pending?.metadata !== undefined) {
          record.feedbackMetadata = clone(pending.metadata);
        }
        record.settled = record.eventStatus === "effective" || record.eventStatus === "rejected";
        this.tryPersistRecords();
      }
      return;
    }
    record.eventStatus = this.ledger.eventStatus(record.payload.eventId);
    if (record.payload.kind === "challenge-created" && record.eventStatus === "effective") {
      const created = record.payload;
      const after = this.ledger.view(this.actor.id);
      const metadata = !before.openChallenges.some(
        (challenge) => challenge.challengeId === created.challengeId,
      ) && after.openChallenges.some(
        (challenge) => challenge.challengeId === created.challengeId,
      )
        ? challengeOpenedFeedback({
            actorName: created.actor.displayName,
            challengeId: created.challengeId,
            activity: {
              waiting: after.counts.waiting,
              live: after.counts.live,
            },
          })
        : null;
      this.resolveFeedback(record, metadata);
    } else if (
      record.payload.kind === "challenge-cancelled" &&
      record.eventStatus === "effective"
    ) {
      const after = this.ledger.view(this.actor.id);
      this.resolveFeedback(record, challengeCancelledFeedback({
        actorName: this.actor.displayName,
        challengeId: record.payload.challengeId,
        activity: {
          waiting: after.counts.waiting,
          live: after.counts.live,
        },
      }));
    } else if (
      record.payload.kind === "challenge-claimed" &&
      record.eventStatus === "effective"
    ) {
      const creatorId = record.feedbackContext?.kind === "challenge-joined"
        ? record.feedbackContext.creatorId
        : undefined;
      const after = this.ledger.view(this.actor.id);
      const metadata = creatorId !== undefined &&
          after.activity.kind === "starting" &&
          after.activity.pairingId === record.payload.eventId
        ? challengeJoinedFeedback({
            joinerName: this.actor.displayName,
            creatorId,
            challengeId: record.payload.challengeId,
            activity: {
              waiting: after.counts.waiting,
              live: after.counts.live,
            },
          })
        : null;
      this.resolveFeedback(record, metadata);
    } else if (record.payload.kind === "pairing-left" && record.eventStatus === "effective") {
      const context = record.feedbackContext?.kind === "pairing-left"
        ? record.feedbackContext
        : undefined;
      const after = this.ledger.view(this.actor.id);
      const activity = { waiting: after.counts.waiting, live: after.counts.live };
      const metadata = context === undefined || context.source !== "challenge"
        ? null
        : context.seatALeft
          ? challengeCancelledFeedback({
              actorName: context.actorName,
              challengeId: context.challengeId,
              activity,
            })
          : { summary: tournamentSummary(activity) };
      this.resolveFeedback(record, metadata);
    } else if (
      record.payload.kind === "practice-completed" &&
      record.eventStatus === "effective"
    ) {
      const completed = record.payload;
      const after = this.ledger.view(this.actor.id);
      const previousRecord = before.practice.record?.score ?? 0;
      const metadata = completed.score > previousRecord &&
          after.practice.record?.player.id === completed.actor.id &&
          after.practice.record.score === completed.score
        ? practiceRecordFeedback({
            playerName: completed.actor.displayName,
            score: completed.score,
            previousChatRecord: previousRecord,
            rulesHash: completed.rulesHash,
            activity: {
              waiting: after.counts.waiting,
              live: after.counts.live,
            },
          })
        : null;
      this.resolveFeedback(record, metadata);
    } else if (!eventRequiresFeedback(record.payload)) {
      record.feedbackStatus = "not-required";
      record.settled = record.eventStatus === "effective";
    }
    this.tryPersistRecords();
  }

  private reconcileMaterializationChanges(): void {
    for (const record of this.recordsByReference.values()) {
      const previousStatus = record.eventStatus;
      const nextStatus = this.ledger.eventStatus(record.payload.eventId);
      if (nextStatus !== "unknown" && !this.ledger.hasCanonicalEvent(record.payload)) {
        this.markRejected(record);
        continue;
      }
      if (previousStatus === "unconfirmed" && nextStatus === "unknown") continue;
      if (previousStatus !== "unconfirmed" || nextStatus !== "unknown") {
        record.eventStatus = nextStatus;
      }
      if (nextStatus === "rejected") {
        this.markRejected(record);
        continue;
      }
      if (nextStatus !== "effective") {
        this.suspendFeedback(record);
        record.settled = false;
        continue;
      }
      if (!eventRequiresFeedback(record.payload)) {
        record.feedbackStatus = "not-required";
        record.settled = true;
        continue;
      }
      if (!record.feedbackPrepared) {
        record.feedbackStatus = "pending";
        this.resolveFeedback(record, this.materializedFeedbackFor(record));
      } else if (record.feedbackStatus === "pending") {
        const pending = this.feedback.get(record.payload.eventId);
        const metadata = record.feedbackMetadata ?? (
          pending?.resolved === true ? pending.metadata : undefined
        );
        if (metadata !== undefined) {
          if (!this.durableOutbox.has(record.payload.eventId)) {
            this.enqueue(projectChatUpdate(record.payload, metadata));
          }
          record.settled = false;
        } else {
          record.feedbackPrepared = false;
          this.resolveFeedback(record, this.materializedFeedbackFor(record));
        }
      } else {
        record.settled = record.feedbackStatus === "confirmed" ||
          record.feedbackStatus === "not-required";
      }
    }
    this.tryPersistRecords();
  }

  private materializedFeedbackFor(record: PersistedIntentRecord): ChatUpdateMetadata | null {
    const view = this.ledger.view(this.actor.id);
    const activity = { waiting: view.counts.waiting, live: view.counts.live };
    const payload = record.payload;
    if (payload.kind === "challenge-created") {
      return challengeOpenedFeedback({
        actorName: payload.actor.displayName,
        challengeId: payload.challengeId,
        activity,
      });
    }
    if (payload.kind === "challenge-cancelled") {
      return challengeCancelledFeedback({
        actorName: payload.actor.displayName,
        challengeId: payload.challengeId,
        activity,
      });
    }
    if (payload.kind === "challenge-claimed") {
      const context = record.feedbackContext?.kind === "challenge-joined"
        ? record.feedbackContext
        : undefined;
      return context === undefined
        ? null
        : challengeJoinedFeedback({
            joinerName: payload.actor.displayName,
            creatorId: context.creatorId,
            challengeId: payload.challengeId,
            activity,
          });
    }
    if (payload.kind === "pairing-left") {
      const context = record.feedbackContext?.kind === "pairing-left"
        ? record.feedbackContext
        : undefined;
      if (context === undefined || context.source !== "challenge") return null;
      return context.seatALeft
        ? challengeCancelledFeedback({
            actorName: context.actorName,
            challengeId: context.challengeId,
            activity,
          })
        : { summary: tournamentSummary(activity) };
    }
    if (payload.kind === "match-started") {
      const context = record.feedbackContext?.kind === "match-started"
        ? record.feedbackContext
        : undefined;
      return context === undefined
        ? null
        : matchStartedFeedback({
            seatAName: context.seatAName,
            seatBName: context.seatBName,
            matchId: payload.matchId,
            activity,
          });
    }
    if (payload.kind === "match-finished") {
      return this.matchResultMetadata(payload.result, view);
    }
    if (payload.kind === "match-conceded") {
      const result = view.recentResults.find((entry) => entry.matchId === payload.matchId);
      return result === undefined
        ? null
        : this.matchResultMetadata(result.result, view, "concession");
    }
    if (payload.kind === "rematch-requested") {
      const context = record.feedbackContext?.kind === "rematch-requested"
        ? record.feedbackContext
        : undefined;
      return context === undefined
        ? null
        : rematchRequestedFeedback({
            requesterName: payload.actor.displayName,
            opponentId: context.opponentId,
            matchId: payload.afterMatchId,
            activity,
          });
    }
    if (payload.kind === "practice-completed") {
      const context = record.feedbackContext?.kind === "practice-record"
        ? record.feedbackContext
        : undefined;
      const currentRecord = view.practice.record;
      return context !== undefined &&
          payload.score > context.previousRecord &&
          currentRecord?.player.id === payload.actor.id &&
          currentRecord.score === payload.score
        ? practiceRecordFeedback({
            playerName: payload.actor.displayName,
            score: payload.score,
            previousChatRecord: context.previousRecord,
            rulesHash: payload.rulesHash,
            activity,
          })
        : null;
    }
    return null;
  }

  private matchResultMetadata(
    result: MatchResultV1,
    view: CompetitionLedgerView,
    reasonOverride?: "concession",
  ): ChatUpdateMetadata | null {
    const seatA = result.players[0];
    const seatB = result.players[1];
    if (seatA === undefined || seatB === undefined) return null;
    const tally = view.headToHead.find((entry) =>
      entry.playerIds.includes(seatA.id) && entry.playerIds.includes(seatB.id)
    );
    const reason = reasonOverride ?? (
      result.reason === "connection-lost" ? "connection-lost" as const : undefined
    );
    return matchResultFeedback({
      matchId: result.matchId,
      seatA: {
        ...seatA,
        score: result.statsByPlayer[seatA.id]?.score ?? 0,
      },
      seatB: {
        ...seatB,
        score: result.statsByPlayer[seatB.id]?.score ?? 0,
      },
      outcome: result.outcome === "seat-a"
        ? "seat-a"
        : result.outcome === "seat-b"
          ? "seat-b"
          : result.outcome === "draw"
            ? "draw"
            : "neutral",
      ...(reason === undefined ? {} : { reason }),
      headToHead: {
        seatAWins: tally?.winsByPlayer[seatA.id] ?? 0,
        seatBWins: tally?.winsByPlayer[seatB.id] ?? 0,
      },
      activity: {
        waiting: view.counts.waiting,
        live: view.counts.live,
      },
    });
  }

  private resolveFeedback(
    record: PersistedIntentRecord,
    metadata: ChatUpdateMetadata | null,
  ): void {
    if (record.feedbackPrepared) return;
    record.feedbackPrepared = true;
    this.rememberFeedbackIntent(record);
    this.feedback.resolve(record.payload.eventId, metadata);
    if (metadata === null) {
      delete record.feedbackMetadata;
      record.feedbackStatus = "not-required";
      record.settled = record.eventStatus === "effective" || record.eventStatus === "rejected";
      this.replayedMetadataByEventId.delete(record.payload.eventId);
      return;
    }
    record.feedbackMetadata = clone(metadata);
    this.tryPersistRecords();
    const expected = projectChatUpdate(record.payload, metadata);
    const replayed = this.replayedMetadataByEventId.get(record.payload.eventId);
    if (replayed?.some((candidate) => metadataMatches(expected, candidate)) === true) {
      this.feedback.acknowledge(record.payload.eventId);
      record.feedbackStatus = "confirmed";
      record.settled = record.eventStatus === "effective" || record.eventStatus === "rejected";
      this.replayedMetadataByEventId.delete(record.payload.eventId);
      return;
    }
    record.feedbackStatus = "pending";
    record.settled = false;
    this.enqueue(expected);
  }

  private rememberFeedbackIntent(record: PersistedIntentRecord): void {
    const payload = record.payload;
    if (payload.kind === "challenge-created") {
      this.feedback.add(payload, { kind: "challenge-created" });
    } else if (payload.kind === "challenge-cancelled") {
      this.feedback.add(payload, { kind: "challenge-cancelled" });
    } else if (payload.kind === "challenge-claimed") {
      const context = record.feedbackContext?.kind === "challenge-joined"
        ? record.feedbackContext
        : undefined;
      if (context !== undefined) {
        this.feedback.add(payload, {
          kind: "challenge-joined",
          creatorId: context.creatorId,
        });
      }
    } else if (payload.kind === "pairing-left") {
      const context = record.feedbackContext?.kind === "pairing-left"
        ? record.feedbackContext
        : undefined;
      if (context !== undefined) {
        this.feedback.add(payload, {
          kind: "pairing-left",
          source: context.source,
          seatALeft: context.seatALeft,
          challengeId: context.challengeId,
          actorName: context.actorName,
        });
      }
    } else if (payload.kind === "match-started") {
      const context = record.feedbackContext?.kind === "match-started"
        ? record.feedbackContext
        : undefined;
      if (context !== undefined) {
        this.feedback.add(payload, {
          kind: "match-started",
          seatAName: context.seatAName,
          seatBName: context.seatBName,
        });
      }
    } else if (payload.kind === "match-finished" || payload.kind === "match-conceded") {
      this.feedback.add(payload, { kind: "match-result" });
    } else if (payload.kind === "rematch-requested") {
      const context = record.feedbackContext?.kind === "rematch-requested"
        ? record.feedbackContext
        : undefined;
      if (context !== undefined) {
        this.feedback.add(payload, {
          kind: "rematch-requested",
          opponentId: context.opponentId,
        });
      }
    } else if (payload.kind === "practice-completed") {
      this.feedback.add(payload, { kind: "practice-record" });
    }
  }

  private suspendFeedback(record: PersistedIntentRecord): void {
    const outbox = this.durableOutbox.get(record.payload.eventId);
    if (outbox !== undefined && carriesChatMetadata(outbox.update)) {
      if (outbox.retryTimer !== null) this.scheduler.clearTimeout(outbox.retryTimer);
      this.durableOutbox.delete(record.payload.eventId);
    }
    if (!eventRequiresFeedback(record.payload) || record.feedbackStatus === "confirmed") return;
    const pending = this.feedback.get(record.payload.eventId);
    if (
      !record.feedbackPrepared &&
      record.feedbackStatus === "pending" &&
      pending?.resolved === false
    ) {
      return;
    }
    this.feedback.resolve(record.payload.eventId, null);
    record.feedbackPrepared = false;
    record.feedbackStatus = "pending";
    delete record.feedbackMetadata;
    this.rememberFeedbackIntent(record);
  }

  private markRejected(record: PersistedIntentRecord): void {
    const outbox = this.durableOutbox.get(record.payload.eventId);
    if (outbox?.retryTimer !== null && outbox?.retryTimer !== undefined) {
      this.scheduler.clearTimeout(outbox.retryTimer);
    }
    this.durableOutbox.delete(record.payload.eventId);
    this.replayedMetadataByEventId.delete(record.payload.eventId);
    record.eventStatus = "rejected";
    if (record.feedbackStatus !== "confirmed") {
      this.feedback.resolve(record.payload.eventId, null);
      record.feedbackPrepared = false;
      record.feedbackStatus = "not-required";
      delete record.feedbackMetadata;
    }
    record.settled = true;
  }

  private acknowledgeOutbox(
    payload: CompetitionEventV2,
    received: DurableReceivedUpdate<unknown>,
  ): OutboxAcknowledgement {
    const entry = this.durableOutbox.get(payload.eventId);
    if (
      entry === undefined ||
      canonicalize(entry.update.payload) !== canonicalize(payload) ||
      !metadataMatches(entry.update, received)
    ) {
      return "none";
    }
    const expectsMetadata = entry.update.info !== undefined ||
      entry.update.href !== undefined ||
      entry.update.summary !== undefined ||
      entry.update.notify !== undefined;
    if (entry.retryTimer !== null) this.scheduler.clearTimeout(entry.retryTimer);
    this.durableOutbox.delete(payload.eventId);
    return expectsMetadata ? "feedback" : "payload";
  }

  private enqueue(
    update: DurableOutboundUpdate<CompetitionEventV2>,
    successfulSendLimit = DURABLE_SUCCESS_SEND_LIMIT,
  ): void {
    if (this.durable === null) return;
    const eventId = update.payload.eventId;
    const previous = this.durableOutbox.get(eventId);
    if (previous?.retryTimer !== null && previous?.retryTimer !== undefined) {
      this.scheduler.clearTimeout(previous.retryTimer);
    }
    const entry: DurableOutboxEntry = {
      update: clone(update),
      successfulSendLimit,
      attempts: 0,
      successfulSends: 0,
      metadataDelivered: false,
      sending: false,
      retryTimer: null,
    };
    this.durableOutbox.set(eventId, entry);
    void this.flushEntry(eventId, entry);
  }

  private async flushEntry(eventId: string, entry: DurableOutboxEntry): Promise<void> {
    if (entry.sending || this.durableOutbox.get(eventId) !== entry) return;
    entry.sending = true;
    let delayMs = DURABLE_RETRY_MIN_MS;
    try {
      await this.sendOnce(
        entry.metadataDelivered ? { payload: entry.update.payload } : entry.update,
        entry,
      );
      entry.metadataDelivered = true;
      entry.attempts = 0;
      entry.successfulSends += 1;
      delayMs = Math.max(
        DURABLE_RETRY_MIN_MS,
        (this.host?.sendUpdateInterval ?? 0) + DURABLE_RETRY_MIN_MS,
      );
    } catch {
      entry.attempts += 1;
      delayMs = Math.min(
        DURABLE_RETRY_MAX_MS,
        DURABLE_RETRY_MIN_MS * 2 ** Math.min(entry.attempts - 1, 4),
      );
    } finally {
      entry.sending = false;
    }
    if (this.durableOutbox.get(eventId) !== entry) return;
    if (entry.successfulSends >= entry.successfulSendLimit) {
      this.durableOutbox.delete(eventId);
      return;
    }
    entry.retryTimer = this.scheduler.setTimeout(() => {
      entry.retryTimer = null;
      void this.flushEntry(eventId, entry);
    }, delayMs);
  }

  private async sendOnce(
    update: DurableOutboundUpdate<CompetitionEventV2>,
    owner: DurableOutboxEntry,
  ): Promise<void> {
    if (this.durable === null) return;
    await new Promise<void>((resolve, reject) => {
      this.appendQueue.push({
        update: clone(update),
        owner,
        terminal: isTerminalIntentPayload(update.payload),
        resolve,
        reject,
      });
      void this.flushAppendQueue();
    });
  }

  private async flushAppendQueue(): Promise<void> {
    if (this.appendRunning || this.durable === null) return;
    this.appendRunning = true;
    try {
      while (this.appendQueue.length > 0) {
        const terminalIndex = this.appendQueue.findIndex((entry) => entry.terminal);
        const [pending] = this.appendQueue.splice(terminalIndex < 0 ? 0 : terminalIndex, 1);
        if (pending === undefined) continue;
        if (this.durableOutbox.get(pending.update.payload.eventId) !== pending.owner) {
          pending.reject(new Error("Durable append was superseded before delivery"));
          continue;
        }
        try {
          const interval = Math.max(0, this.host?.sendUpdateInterval ?? 0);
          const delay = this.lastAppendMs + interval - this.scheduler.now();
          if (delay > 0) await this.wait(delay);
          if (this.durableOutbox.get(pending.update.payload.eventId) !== pending.owner) {
            pending.reject(new Error("Durable append was superseded before delivery"));
            continue;
          }
          await this.durable.append(pending.update);
          this.lastAppendMs = this.scheduler.now();
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        }
      }
    } finally {
      this.appendRunning = false;
      if (this.appendQueue.length > 0) void this.flushAppendQueue();
    }
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduler.setTimeout(resolve, Math.max(0, milliseconds));
    });
  }

  private refresh(incrementRevision = true): void {
    this.pruneSettledHistory();
    if (incrementRevision) this.revision += 1;
    this.snapshot = this.buildSnapshot();
    for (const subscription of this.observers) {
      this.deliver(subscription.observer, subscription.state, this.snapshot);
    }
  }

  private buildSnapshot(): CompetitionLifecycleSnapshot {
    return deepFreeze({
      revision: this.revision,
      competition: projectCompetitionView(this.ledger.view(this.actor.id)),
      intents: [...this.recordsByReference.values()].map((record) => ({
        reference: record.reference,
        intent: clone(record.intent),
        eventStatus: record.eventStatus,
        feedbackStatus: record.feedbackStatus,
        settled: record.settled,
      })),
    });
  }

  private loadRecords(): void {
    let encoded: string | null;
    try {
      encoded = this.storage.getItem(this.storageKey);
    } catch {
      return;
    }
    if (encoded === null) {
      this.legacyAdoptionAllowed = true;
      return;
    }
    if (encoded.length > MAX_INTENT_STORAGE_CHARACTERS) return;
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (!Array.isArray(parsed)) return;
      for (const candidate of parsed) {
        if (
          isRecord(candidate) &&
          isCompetitionEventV2(candidate.payload) &&
          candidate.payload.actor.id === this.actor.id
        ) {
          this.claimedIntentStoreEventIds.add(candidate.payload.eventId);
        }
      }
      for (const candidate of parsed) {
        if (!isPersistedIntentRecord(candidate, this.actor.id)) continue;
        const record = clone(candidate);
        if (
          this.recordsByReference.has(record.reference) ||
          this.referenceByEventId.has(record.payload.eventId) ||
          this.usedPrivateIds.has(record.reference) ||
          this.usedPrivateIds.has(record.payload.eventId) ||
          this.referenceByEventId.has(record.reference) ||
          this.recordsByReference.has(record.payload.eventId as CompetitionIntentReference)
        ) {
          continue;
        }
        if (!record.settled && !this.hasIntentCapacity(record.payload)) continue;
        const recoveredFeedback = this.feedback.get(record.payload.eventId);
        record.feedbackPrepared = record.feedbackStatus === "pending"
          ? record.feedbackMetadata !== undefined || recoveredFeedback?.resolved === true
          : candidate.feedbackPrepared ?? recoveredFeedback?.resolved === true;
        if (
          record.feedbackMetadata === undefined &&
          recoveredFeedback?.resolved === true &&
          recoveredFeedback.metadata !== undefined
        ) {
          record.feedbackMetadata = clone(recoveredFeedback.metadata);
        }
        this.recordsByReference.set(record.reference, record);
        this.referenceByEventId.set(record.payload.eventId, record.reference);
        this.usedPrivateIds.add(record.reference);
        this.reservePayloadIdentifiers(record.payload);
        this.clock.observe(record.payload.logicalClock);
      }
      this.pruneSettledHistory();
    } catch {
      // Invalid recovery data is ignored at the local persistence seam.
    }
  }

  private adoptLegacyFeedbackEntries(): void {
    if (!this.legacyAdoptionAllowed) return;
    const entries = this.feedback.entries();
    const legacyEventIds = entries.map((entry) => entry.payload.eventId);
    const adopted: PersistedIntentRecord[] = [];
    for (const entry of entries) {
      if (
        this.referenceByEventId.has(entry.payload.eventId) ||
        this.usedPrivateIds.has(entry.payload.eventId) ||
        this.claimedIntentStoreEventIds.has(entry.payload.eventId) ||
        !this.hasIntentCapacity(entry.payload)
      ) {
        continue;
      }
      const intent = intentForPayload(entry.payload);
      if (intent === null) continue;
      let reference: CompetitionIntentReference;
      try {
        reference = this.freshPrivateId(
          "recovered Competition Intent Reference",
          legacyEventIds,
        ) as CompetitionIntentReference;
      } catch {
        continue;
      }
      const status = this.ledger.eventStatus(entry.payload.eventId);
      const feedbackContext = this.legacyFeedbackContext(entry);
      const record: PersistedIntentRecord = {
        schema: STORAGE_SCHEMA,
        reference,
        intent,
        payload: clone(entry.payload),
        ...(feedbackContext === undefined ? {} : { feedbackContext }),
        feedbackPrepared: entry.resolved,
        ...(entry.resolved && entry.metadata !== undefined
          ? { feedbackMetadata: clone(entry.metadata) }
          : {}),
        eventStatus: status === "unknown" ? "unconfirmed" : status,
        feedbackStatus: "pending",
        settled: false,
      };
      if (!isPersistedIntentRecord(record, this.actor.id)) continue;
      this.recordsByReference.set(reference, record);
      this.referenceByEventId.set(record.payload.eventId, reference);
      this.reservePayloadIdentifiers(record.payload);
      this.clock.observe(record.payload.logicalClock);
      adopted.push(record);
    }
    if (adopted.length === 0) return;
    try {
      this.persistRecords();
    } catch {
      for (const record of adopted) {
        this.recordsByReference.delete(record.reference);
        this.referenceByEventId.delete(record.payload.eventId);
      }
    }
  }

  private legacyFeedbackContext(
    entry: PendingChatFeedbackV2,
  ): PersistedIntentRecord["feedbackContext"] {
    const resolver = entry.resolver;
    if (resolver.kind === "challenge-joined") {
      return { kind: "challenge-joined", creatorId: resolver.creatorId };
    }
    if (resolver.kind === "pairing-left") {
      return {
        kind: "pairing-left",
        source: resolver.source,
        seatALeft: resolver.seatALeft,
        challengeId: resolver.challengeId,
        actorName: resolver.actorName,
      };
    }
    if (resolver.kind === "match-started") {
      return {
        kind: "match-started",
        seatAName: resolver.seatAName,
        seatBName: resolver.seatBName,
      };
    }
    if (resolver.kind === "rematch-requested") {
      return { kind: "rematch-requested", opponentId: resolver.opponentId };
    }
    if (resolver.kind === "practice-record") {
      return { kind: "practice-record", previousRecord: 0 };
    }
    return undefined;
  }

  private loadDerivedEvents(): void {
    let encoded: string | null;
    try {
      encoded = this.storage.getItem(this.derivedStorageKey);
    } catch {
      return;
    }
    if (encoded === null) return;
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (!Array.isArray(parsed)) return;
      for (const candidate of parsed) {
        if (
          !isRecord(candidate) ||
          candidate.schema !== DERIVED_STORAGE_SCHEMA ||
          typeof candidate.key !== "string" ||
          !isCompetitionEventV2(candidate.payload)
        ) {
          continue;
        }
        const key = candidate.key;
        const payload = candidate.payload;
        if (
          payload.kind !== "runtime-claimed" ||
          payload.actor.id !== this.actor.id ||
          payload.runtimeSessionId !== this.runtimeSessionId ||
          key !== `runtime:${payload.runtimeSessionId}:${payload.pairingId}` ||
          this.derivedByKey.has(key) ||
          this.usedPrivateIds.has(payload.eventId) ||
          this.recordsByReference.has(payload.eventId as CompetitionIntentReference) ||
          this.referenceByEventId.has(payload.eventId) ||
          [...this.derivedByKey.values()].some(
            (derived) => derived.payload.eventId === payload.eventId,
          )
        ) {
          continue;
        }
        const derived: PersistedDerivedEvent = {
          schema: DERIVED_STORAGE_SCHEMA,
          key,
          payload: clone(payload),
        };
        this.derivedByKey.set(derived.key, derived);
        this.reservePayloadIdentifiers(derived.payload);
        this.clock.observe(derived.payload.logicalClock);
      }
    } catch {
      // Invalid recovery data is ignored at the local persistence seam.
    }
  }

  private persistRecords(): void {
    this.pruneSettledHistory();
    let records = [...this.recordsByReference.values()];
    const active = records.filter((record) => !record.settled);
    const activeNonterminal = active.filter((record) =>
      !isTerminalIntentPayload(record.payload)
    );
    const activeTerminalCount = active.length - activeNonterminal.length;
    if (
      active.length > MAX_PENDING_INTENT_RECORDS ||
      activeNonterminal.length > MAX_PENDING_INTENT_RECORDS - TERMINAL_INTENT_RESERVE
    ) {
      throw new RangeError("Competition Intent recovery capacity is full");
    }
    const remainingTerminalSlots = Math.max(
      0,
      TERMINAL_INTENT_RESERVE - activeTerminalCount,
    );
    const storageLimit = MAX_INTENT_STORAGE_CHARACTERS -
      remainingTerminalSlots * TERMINAL_INTENT_STORAGE_RESERVE_CHARACTERS;
    let encoded = JSON.stringify(records);
    while (encoded.length > storageLimit) {
      const oldestSettled = records.find((record) => record.settled);
      if (oldestSettled === undefined) break;
      this.recordsByReference.delete(oldestSettled.reference);
      this.referenceByEventId.delete(oldestSettled.payload.eventId);
      this.replayedMetadataByEventId.delete(oldestSettled.payload.eventId);
      records = [...this.recordsByReference.values()];
      encoded = JSON.stringify(records);
    }
    if (encoded.length > storageLimit) {
      throw new RangeError("Competition Intent recovery storage is full");
    }
    this.storage.setItem(this.storageKey, encoded);
  }

  private tryPersistRecords(): void {
    try {
      this.persistRecords();
    } catch {
      // Canonical materialization remains authoritative when local recovery degrades.
    }
  }

  private persistDerivedEvents(): void {
    this.storage.setItem(
      this.derivedStorageKey,
      JSON.stringify([...this.derivedByKey.values()]),
    );
  }

  private boundedId(value: string, label: string, maximum: number): string {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
      throw new RangeError(`${label} must contain 1-${maximum} characters`);
    }
    return value;
  }

  private freshPrivateId(label: string, forbidden: readonly string[] = []): string {
    const value = this.boundedId(this.createId(), label, 256);
    const alreadyUsed = forbidden.includes(value) ||
      this.usedPrivateIds.has(value) ||
      this.recordsByReference.has(value as CompetitionIntentReference) ||
      this.referenceByEventId.has(value) ||
      [...this.derivedByKey.values()].some((derived) => derived.payload.eventId === value);
    if (alreadyUsed) throw new RangeError(`${label} must be unique`);
    this.usedPrivateIds.add(value);
    return value;
  }

  private reservePayloadIdentifiers(payload: CompetitionEventV2): void {
    for (const identifier of competitionIdentifiers(payload)) {
      this.usedPrivateIds.add(identifier);
    }
  }

  private hasIntentCapacity(payload: CompetitionEventV2): boolean {
    const active = [...this.recordsByReference.values()].filter((record) => !record.settled);
    if (active.length >= MAX_PENDING_INTENT_RECORDS) return false;
    if (isTerminalIntentPayload(payload)) return true;
    const activeNonterminal = active.filter((record) =>
      !isTerminalIntentPayload(record.payload)
    ).length;
    return activeNonterminal < MAX_PENDING_INTENT_RECORDS - TERMINAL_INTENT_RESERVE;
  }

  private pruneSettledHistory(): void {
    const settled = [...this.recordsByReference.values()].filter((record) => record.settled);
    const excess = settled.length - MAX_SETTLED_INTENT_HISTORY;
    if (excess <= 0) return;
    for (const record of settled.slice(0, excess)) {
      this.recordsByReference.delete(record.reference);
      this.referenceByEventId.delete(record.payload.eventId);
      this.replayedMetadataByEventId.delete(record.payload.eventId);
    }
  }

  private pruneReplayMetadataCandidates(): void {
    for (const eventId of this.replayedMetadataByEventId.keys()) {
      if (!this.referenceByEventId.has(eventId)) {
        this.replayedMetadataByEventId.delete(eventId);
      }
    }
  }
}

export async function createCompetitionEventLifecycle(
  options: CompetitionEventLifecycleOptions,
): Promise<CompetitionEventLifecycle> {
  const implementation = new CompetitionEventLifecycleImplementation(options);
  await implementation.start();
  return implementation.interface();
}
