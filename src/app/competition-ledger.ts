import { RULES } from "../config/rules";
import { hashCanonicalHex } from "../domain/hashing";
import { cloneMatchResult } from "../domain/results";
import type { MatchResult, PlayerResultStats } from "../domain/types";
import { MAX_DURABLE_LOGICAL_CLOCK } from "../network/webxdc-durable";
import { isMatchResult } from "../persistence/history";

export const COMPETITION_EVENT_SCHEMA = "split-stack/competition/v2" as const;
export const COMPETITION_LEDGER_MAX_EVENTS = 100_000;
const MAX_RESULT_VARIANTS_PER_MATCH = 2;

export interface CompetitionActor {
  readonly id: string;
  readonly displayName: string;
}

interface CompetitionEventBase {
  readonly schema: typeof COMPETITION_EVENT_SCHEMA;
  readonly eventId: string;
  readonly logicalClock: number;
  readonly actor: CompetitionActor;
}

export interface ChallengeCreated extends CompetitionEventBase {
  readonly kind: "challenge-created";
  readonly challengeId: string;
  readonly rulesHash: string;
  readonly vacancyId: string;
}

export interface ChallengeClaimed extends CompetitionEventBase {
  readonly kind: "challenge-claimed";
  readonly challengeId: string;
  readonly vacancyId: string;
}

export interface ChallengeCancelled extends CompetitionEventBase {
  readonly kind: "challenge-cancelled";
  readonly challengeId: string;
}

export interface PairingLeft extends CompetitionEventBase {
  readonly kind: "pairing-left";
  readonly pairingId: string;
  readonly runtimeSessionId: string;
}

export interface RuntimeClaimed extends CompetitionEventBase {
  readonly kind: "runtime-claimed";
  readonly pairingId: string;
  readonly runtimeSessionId: string;
}

export interface ReadyChanged extends CompetitionEventBase {
  readonly kind: "ready-changed";
  readonly pairingId: string;
  readonly runtimeSessionId: string;
  readonly ready: boolean;
}

export interface MatchStarted extends CompetitionEventBase {
  readonly kind: "match-started";
  readonly pairingId: string;
  readonly seriesId: string;
  readonly round: number;
  readonly matchId: string;
  readonly rulesHash: string;
  readonly configHash: string;
  readonly seed: string;
  readonly seedHash: string;
  readonly seatAPlayerId: string;
  readonly seatBPlayerId: string;
  readonly seatASessionId: string;
  readonly seatBSessionId: string;
}

export interface MatchFinished extends CompetitionEventBase {
  readonly kind: "match-finished";
  readonly matchId: string;
  readonly startedEventId: string;
  readonly result: MatchResult;
}

export interface MatchConceded extends CompetitionEventBase {
  readonly kind: "match-conceded";
  readonly matchId: string;
  readonly startedEventId: string;
}

export interface RematchRequested extends CompetitionEventBase {
  readonly kind: "rematch-requested";
  readonly seriesId: string;
  readonly afterMatchId: string;
  readonly round: number;
}

export interface RematchAccepted extends CompetitionEventBase {
  readonly kind: "rematch-accepted";
  readonly seriesId: string;
  readonly afterMatchId: string;
  readonly round: number;
  readonly requestedEventId: string;
}

export interface RematchWithdrawn extends CompetitionEventBase {
  readonly kind: "rematch-withdrawn";
  readonly seriesId: string;
  readonly round: number;
}

export interface PracticeCompleted extends CompetitionEventBase {
  readonly kind: "practice-completed";
  readonly rulesHash: string;
  readonly runId: string;
  readonly endReason: "top-out";
  readonly score: number;
  readonly durationTicks: number;
  readonly finalLevel: number;
  readonly finalStats: PlayerResultStats;
}

export type CompetitionEvent =
  | ChallengeCreated
  | ChallengeClaimed
  | ChallengeCancelled
  | PairingLeft
  | RuntimeClaimed
  | ReadyChanged
  | MatchStarted
  | MatchFinished
  | MatchConceded
  | RematchRequested
  | RematchAccepted
  | RematchWithdrawn
  | PracticeCompleted;

export interface CompetitionDurableRecord {
  readonly serial: number;
  readonly payload: unknown;
}

export type PlayerCompetitionActivity =
  | { readonly kind: "idle" }
  | { readonly kind: "waiting"; readonly challengeId: string }
  | {
      readonly kind: "starting";
      readonly pairingId: string;
      readonly matchId: string;
      readonly seriesId: string;
      readonly round: number;
    }
  | {
      readonly kind: "live";
      readonly pairingId: string;
      readonly matchId: string;
      readonly seriesId: string;
      readonly round: number;
    };

export interface OpenChallengeView {
  readonly challengeId: string;
  readonly creator: CompetitionActor;
  readonly rulesHash: string;
  readonly vacancyId: string;
}

export interface StartingPairingView {
  readonly pairingId: string;
  readonly source: "challenge" | "rematch";
  readonly challengeId?: string;
  readonly seriesId: string;
  readonly round: number;
  readonly matchId: string;
  readonly seatA: CompetitionActor;
  readonly seatB: CompetitionActor;
  readonly readyByPlayer: Readonly<Record<string, boolean>>;
  readonly runtimeSessionByPlayer: Readonly<Record<string, string | undefined>>;
}

export interface LiveMatchView {
  readonly pairingId: string;
  readonly source: "challenge" | "rematch";
  readonly challengeId?: string;
  readonly seriesId: string;
  readonly round: number;
  readonly matchId: string;
  readonly seatA: CompetitionActor;
  readonly seatB: CompetitionActor;
  readonly runtimeSessionByPlayer: Readonly<Record<string, string | undefined>>;
  readonly startedEventId: string;
  readonly start: MatchStarted;
}

export interface CompetitionResultView {
  readonly matchId: string;
  readonly seriesId: string;
  readonly round: number;
  readonly result: MatchResult;
  readonly conflicted: boolean;
  readonly variantCount: number;
}

export interface StandingView {
  readonly player: CompetitionActor;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly games: number;
  readonly winRate: number;
}

export interface HeadToHeadView {
  readonly playerIds: readonly [string, string];
  readonly players: readonly [CompetitionActor, CompetitionActor];
  readonly winsByPlayer: Readonly<Record<string, number>>;
  readonly draws: number;
}

export interface SeriesScoreView {
  readonly seriesId: string;
  readonly players: readonly [CompetitionActor, CompetitionActor];
  readonly winsByPlayer: Readonly<Record<string, number>>;
  readonly draws: number;
  readonly completedRounds: number;
  readonly latestRound: number;
}

export interface PendingRematchView {
  readonly seriesId: string;
  readonly afterMatchId: string;
  readonly round: number;
  readonly seatA: CompetitionActor;
  readonly seatB: CompetitionActor;
  readonly requestedByPlayerIds: readonly string[];
  readonly requestEventIdByPlayer: Readonly<Record<string, string | undefined>>;
}

export interface RejectedClaimView {
  readonly claimEventId: string;
  readonly challengeId: string;
  readonly vacancyId: string;
  readonly claimant: CompetitionActor;
  readonly reason:
    | "vacancy-claimed"
    | "stale-vacancy"
    | "self-join"
    | "already-committed"
    | "challenge-unavailable";
  readonly winningPairingId?: string;
}

export interface PracticeLeaderboardEntry {
  readonly rank: number;
  readonly player: CompetitionActor;
  readonly score: number;
  readonly eventId: string;
  readonly runId: string;
  readonly durationTicks: number;
  readonly finalLevel: number;
  readonly finalStats: PlayerResultStats;
}

export interface PracticeLeaderboardView {
  readonly rulesHash: string;
  readonly totalPlayers: number;
  readonly leaderboard: readonly PracticeLeaderboardEntry[];
  readonly pinned: PracticeLeaderboardEntry | null;
  readonly personalBest: PracticeLeaderboardEntry | null;
  readonly record: PracticeLeaderboardEntry | null;
}

export interface CompetitionLedgerView {
  readonly counts: {
    readonly waiting: number;
    readonly starting: number;
    readonly live: number;
    readonly completed: number;
  };
  readonly activity: PlayerCompetitionActivity;
  readonly openChallenges: readonly OpenChallengeView[];
  readonly startingPairings: readonly StartingPairingView[];
  readonly liveMatches: readonly LiveMatchView[];
  readonly recentResults: readonly CompetitionResultView[];
  readonly standings: readonly StandingView[];
  readonly headToHead: readonly HeadToHeadView[];
  readonly seriesScores: readonly SeriesScoreView[];
  readonly pendingRematches: readonly PendingRematchView[];
  readonly rejectedClaims: readonly RejectedClaimView[];
  readonly practice: PracticeLeaderboardView;
}

export interface CompetitionLedgerOptions {
  readonly currentRulesHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const RESULT_KEYS = [
  "completedBy",
  "durationTicks",
  "finalLevel",
  "matchId",
  "outcome",
  "players",
  "reason",
  "schema",
  "seedHash",
  "statsByPlayer",
] as const;
const RESULT_PLAYER_KEYS = ["displayName", "id"] as const;
const RESULT_STATS_KEYS = [
  "garbageSent",
  "lines",
  "powersActivated",
  "score",
  "tSpinDoubles",
  "tSpinSingles",
  "tSpinTriples",
  "tetrises",
] as const;

function isStrictResultStats(value: unknown): value is PlayerResultStats {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const expected = value.topOutTick === undefined
    ? RESULT_STATS_KEYS
    : [...RESULT_STATS_KEYS, "topOutTick"];
  return hasExactKeys(value, expected) &&
    RESULT_STATS_KEYS.every((key) => isNonNegativeInteger(value[key])) &&
    (value.topOutTick === undefined || isNonNegativeInteger(value.topOutTick)) &&
    keys.length === expected.length;
}

function isStrictMatchResult(value: unknown): value is MatchResult {
  if (!isMatchResult(value) || !isRecord(value) || !hasExactKeys(value, RESULT_KEYS)) {
    return false;
  }
  if (
    !value.players.every(
      (player) => isRecord(player) && hasExactKeys(player, RESULT_PLAYER_KEYS),
    ) ||
    !isRecord(value.statsByPlayer)
  ) {
    return false;
  }
  const playerIds = value.players.map((player) => player.id).sort(compareCodeUnits);
  return Object.keys(value.statsByPlayer).sort(compareCodeUnits).every(
    (key, index) => key === playerIds[index],
  ) && Object.values(value.statsByPlayer).every(isStrictResultStats);
}

function expectedConfigHash(event: MatchStarted): string {
  return hashCanonicalHex({
    rulesVersion: RULES.rulesVersion,
    rulesHash: event.rulesHash,
    seed: event.seed,
    seatAPlayerId: event.seatAPlayerId,
    seatBPlayerId: event.seatBPlayerId,
  });
}

export function isCompetitionEvent(value: unknown): value is CompetitionEvent {
  if (!isRecord(value) || !isRecord(value.actor)) return false;
  if (
    value.schema !== COMPETITION_EVENT_SCHEMA ||
    !hasExactKeys(value.actor, ["displayName", "id"]) ||
    !isBoundedString(value.eventId, 256) ||
    !Number.isSafeInteger(value.logicalClock) ||
    (value.logicalClock as number) < 1 ||
    (value.logicalClock as number) > MAX_DURABLE_LOGICAL_CLOCK ||
    !isBoundedString(value.actor.id, 256) ||
    !isBoundedString(value.actor.displayName, 128)
  ) {
    return false;
  }
  if (value.kind === "challenge-created") {
    return hasExactKeys(value, [
      "actor",
      "challengeId",
      "eventId",
      "kind",
      "logicalClock",
      "rulesHash",
      "schema",
      "vacancyId",
    ]) &&
      isBoundedString(value.challengeId, 256) &&
      isBoundedString(value.rulesHash, 256) &&
      isBoundedString(value.vacancyId, 256);
  }
  if (value.kind === "challenge-claimed") {
    return hasExactKeys(value, [
      "actor",
      "challengeId",
      "eventId",
      "kind",
      "logicalClock",
      "schema",
      "vacancyId",
    ]) &&
      isBoundedString(value.challengeId, 256) &&
      isBoundedString(value.vacancyId, 256);
  }
  if (value.kind === "challenge-cancelled") {
    return hasExactKeys(value, [
      "actor",
      "challengeId",
      "eventId",
      "kind",
      "logicalClock",
      "schema",
    ]) && isBoundedString(value.challengeId, 256);
  }
  if (value.kind === "pairing-left") {
    return hasExactKeys(value, [
      "actor",
      "eventId",
      "kind",
      "logicalClock",
      "pairingId",
      "runtimeSessionId",
      "schema",
    ]) &&
      isBoundedString(value.pairingId, 256) &&
      isBoundedString(value.runtimeSessionId, 128);
  }
  if (value.kind === "runtime-claimed") {
    return hasExactKeys(value, [
      "actor",
      "eventId",
      "kind",
      "logicalClock",
      "pairingId",
      "runtimeSessionId",
      "schema",
    ]) &&
      isBoundedString(value.pairingId, 256) &&
      isBoundedString(value.runtimeSessionId, 128);
  }
  if (value.kind === "ready-changed") {
    return hasExactKeys(value, [
      "actor",
      "eventId",
      "kind",
      "logicalClock",
      "pairingId",
      "ready",
      "runtimeSessionId",
      "schema",
    ]) &&
      isBoundedString(value.pairingId, 256) &&
      isBoundedString(value.runtimeSessionId, 128) &&
      typeof value.ready === "boolean";
  }
  if (value.kind === "match-started") {
    if (!hasExactKeys(value, [
      "actor",
      "configHash",
      "eventId",
      "kind",
      "logicalClock",
      "matchId",
      "pairingId",
      "round",
      "rulesHash",
      "schema",
      "seatAPlayerId",
      "seatASessionId",
      "seatBPlayerId",
      "seatBSessionId",
      "seed",
      "seedHash",
      "seriesId",
    ])) {
      return false;
    }
    const candidate = value as unknown as MatchStarted;
    return isBoundedString(candidate.pairingId, 256) &&
      isBoundedString(candidate.seriesId, 256) &&
      Number.isSafeInteger(candidate.round) && candidate.round > 0 && candidate.round < 10_000 &&
      candidate.matchId === `${candidate.seriesId}:round:${candidate.round}` &&
      isBoundedString(candidate.rulesHash, 256) &&
      isBoundedString(candidate.configHash, 256) &&
      /^[0-9a-f]{32}$/i.test(candidate.seed) &&
      candidate.seedHash === hashCanonicalHex({ seed: candidate.seed }) &&
      isBoundedString(candidate.seatAPlayerId, 256) &&
      isBoundedString(candidate.seatBPlayerId, 256) &&
      candidate.seatAPlayerId !== candidate.seatBPlayerId &&
      candidate.actor.id === candidate.seatAPlayerId &&
      isBoundedString(candidate.seatASessionId, 128) &&
      isBoundedString(candidate.seatBSessionId, 128) &&
      candidate.configHash === expectedConfigHash(candidate);
  }
  if (value.kind === "match-finished") {
    return hasExactKeys(value, [
      "actor",
      "eventId",
      "kind",
      "logicalClock",
      "matchId",
      "result",
      "schema",
      "startedEventId",
    ]) &&
      isBoundedString(value.matchId, 256) &&
      isBoundedString(value.startedEventId, 256) &&
      isStrictMatchResult(value.result);
  }
  if (value.kind === "match-conceded") {
    return hasExactKeys(value, [
      "actor",
      "eventId",
      "kind",
      "logicalClock",
      "matchId",
      "schema",
      "startedEventId",
    ]) &&
      isBoundedString(value.matchId, 256) &&
      isBoundedString(value.startedEventId, 256);
  }
  if (value.kind === "rematch-requested") {
    return hasExactKeys(value, [
      "actor",
      "afterMatchId",
      "eventId",
      "kind",
      "logicalClock",
      "round",
      "schema",
      "seriesId",
    ]) &&
      isBoundedString(value.seriesId, 256) &&
      isBoundedString(value.afterMatchId, 256) &&
      Number.isSafeInteger(value.round) &&
      (value.round as number) > 1 &&
      (value.round as number) < 10_000;
  }
  if (value.kind === "rematch-accepted") {
    return hasExactKeys(value, [
      "actor",
      "afterMatchId",
      "eventId",
      "kind",
      "logicalClock",
      "requestedEventId",
      "round",
      "schema",
      "seriesId",
    ]) &&
      isBoundedString(value.seriesId, 256) &&
      isBoundedString(value.afterMatchId, 256) &&
      isBoundedString(value.requestedEventId, 256) &&
      Number.isSafeInteger(value.round) &&
      (value.round as number) > 1 &&
      (value.round as number) < 10_000;
  }
  if (value.kind === "rematch-withdrawn") {
    return hasExactKeys(value, [
      "actor",
      "eventId",
      "kind",
      "logicalClock",
      "round",
      "schema",
      "seriesId",
    ]) &&
      isBoundedString(value.seriesId, 256) &&
      Number.isSafeInteger(value.round) &&
      (value.round as number) > 1 &&
      (value.round as number) < 10_000;
  }
  if (value.kind === "practice-completed") {
    return hasExactKeys(value, [
      "actor",
      "durationTicks",
      "endReason",
      "eventId",
      "finalLevel",
      "finalStats",
      "kind",
      "logicalClock",
      "rulesHash",
      "runId",
      "schema",
      "score",
    ]) &&
      isBoundedString(value.rulesHash, 256) &&
      isBoundedString(value.runId, 256) &&
      value.endReason === "top-out" &&
      isNonNegativeInteger(value.score) &&
      isNonNegativeInteger(value.durationTicks) &&
      Number.isSafeInteger(value.finalLevel) &&
      (value.finalLevel as number) >= 1 &&
      isStrictResultStats(value.finalStats) &&
      value.finalStats.topOutTick === value.durationTicks &&
      value.finalStats.score === value.score;
  }
  return false;
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareEvents(left: CompetitionEvent, right: CompetitionEvent): number {
  return left.logicalClock - right.logicalClock ||
    compareCodeUnits(left.actor.id, right.actor.id) ||
    compareCodeUnits(left.eventId, right.eventId) ||
    compareCodeUnits(left.kind, right.kind);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function cloneEvent(event: CompetitionEvent): CompetitionEvent {
  return JSON.parse(stableJson(event)) as CompetitionEvent;
}

interface MutableChallenge {
  challengeId: string;
  creator: CompetitionActor;
  rulesHash: string;
  vacancyId: string;
  status: "waiting" | "starting" | "live" | "completed";
  pairingId?: string;
}

interface MutablePairing {
  pairingId: string;
  source: "challenge" | "rematch";
  challengeId?: string;
  seriesId: string;
  round: number;
  matchId: string;
  seatA: CompetitionActor;
  seatB: CompetitionActor;
  status: "starting" | "live" | "completed";
  readyByPlayer: Record<string, boolean>;
  runtimeSessionByPlayer: Record<string, string | undefined>;
  started?: MatchStarted;
  firstFinish?: MatchFinished;
  firstFinishOrder?: number;
  resultVariants: Map<string, MatchResult>;
}

interface MutableRematch {
  seriesId: string;
  afterMatchId: string;
  round: number;
  seatA: CompetitionActor;
  seatB: CompetitionActor;
  requestedBy: Set<string>;
  requestEventIdByPlayer: Record<string, string | undefined>;
  status: "pending" | "paired" | "invalidated";
  pairingId?: string;
}

interface CompetitionMaterialization {
  readonly view: CompetitionLedgerView;
  readonly trackedEventStatus: CompetitionEventStatus;
  readonly deferredMatchStarts: readonly MatchStarted[];
}

export type CompetitionEventStatus = "unknown" | "deferred" | "effective" | "rejected";

function pairingActivity(
  pairing: MutablePairing,
  kind: "starting" | "live",
): PlayerCompetitionActivity {
  return {
    kind,
    pairingId: pairing.pairingId,
    matchId: pairing.matchId,
    seriesId: pairing.seriesId,
    round: pairing.round,
  };
}

function actorInPairing(pairing: MutablePairing, actorId: string): boolean {
  return actorId === pairing.seatA.id || actorId === pairing.seatB.id;
}

function resultMatchesPairing(result: MatchResult, pairing: MutablePairing): boolean {
  const start = pairing.started;
  return start !== undefined &&
    result.matchId === start.matchId &&
    result.seedHash === start.seedHash &&
    result.players[0]?.id === pairing.seatA.id &&
    result.players[1]?.id === pairing.seatB.id;
}

function concessionResult(
  event: MatchConceded,
  pairing: MutablePairing,
): MatchResult | undefined {
  const start = pairing.started;
  if (start === undefined || !actorInPairing(pairing, event.actor.id)) return undefined;
  const emptyStats = (): PlayerResultStats => ({
    score: 0,
    lines: 0,
    garbageSent: 0,
    powersActivated: 0,
    tetrises: 0,
    tSpinSingles: 0,
    tSpinDoubles: 0,
    tSpinTriples: 0,
  });
  return {
    schema: "split-stack/result/v1",
    matchId: pairing.matchId,
    seedHash: start.seedHash,
    players: [{ ...pairing.seatA }, { ...pairing.seatB }],
    outcome: event.actor.id === pairing.seatA.id ? "seat-b" : "seat-a",
    reason: "forfeit",
    durationTicks: 0,
    finalLevel: 1,
    statsByPlayer: {
      [pairing.seatA.id]: emptyStats(),
      [pairing.seatB.id]: emptyStats(),
    },
    completedBy: event.actor.id,
  };
}

function materializeResult(pairing: MutablePairing): CompetitionResultView | undefined {
  const variants = [...pairing.resultVariants.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right)
  );
  const base = variants[0]?.[1];
  if (base === undefined) return undefined;
  const conflicted = variants.length > 1;
  const result = cloneMatchResult(base);
  if (conflicted) {
    const allConnectionLost = variants.every(([, variant]) =>
      variant.outcome === "desync" && variant.reason === "connection-lost"
    );
    result.outcome = "desync";
    result.reason = allConnectionLost ? "connection-lost" : "desynchronization";
  }
  return {
    matchId: pairing.matchId,
    seriesId: pairing.seriesId,
    round: pairing.round,
    result,
    conflicted,
    variantCount: variants.length,
  };
}

function pairKey(first: string, second: string): string {
  return `${first.length}:${first}${second.length}:${second}`;
}

function rematchKey(seriesId: string, round: number): string {
  return `${seriesId.length}:${seriesId}${round}`;
}

/** Deterministically materializes the v2 durable competition log. */
export class CompetitionLedger {
  private readonly currentRulesHash: string;
  private readonly eventsById = new Map<string, CompetitionEvent>();

  public constructor(options: CompetitionLedgerOptions) {
    if (!isBoundedString(options.currentRulesHash, 256)) {
      throw new TypeError("Current rules hash must be a bounded non-empty string");
    }
    this.currentRulesHash = options.currentRulesHash;
  }

  public apply(record: CompetitionDurableRecord): boolean {
    if (
      !Number.isSafeInteger(record.serial) ||
      record.serial < 1 ||
      !isCompetitionEvent(record.payload)
    ) {
      return false;
    }
    const candidate = cloneEvent(record.payload);
    const existing = this.eventsById.get(candidate.eventId);
    if (existing !== undefined) {
      // Durable serials are replica-local cursors. Resolve an event-id collision
      // from payload bytes alone so every replica retains the same variant.
      const candidateFingerprint = stableJson(candidate);
      const existingFingerprint = stableJson(existing);
      if (candidateFingerprint >= existingFingerprint) return false;
    }
    if (existing === undefined && this.eventsById.size >= COMPETITION_LEDGER_MAX_EVENTS) {
      return false;
    }
    this.eventsById.set(candidate.eventId, candidate);
    return true;
  }

  public hasCanonicalEvent(event: CompetitionEvent): boolean {
    const existing = this.eventsById.get(event.eventId);
    return existing !== undefined && stableJson(existing) === stableJson(event);
  }

  public view(playerId?: string): CompetitionLedgerView {
    return this.materialize(playerId).view;
  }

  public isEventEffective(eventId: string): boolean {
    return this.eventStatus(eventId) === "effective";
  }

  public eventStatus(eventId: string): CompetitionEventStatus {
    if (!isBoundedString(eventId, 256)) return "unknown";
    return this.materialize(undefined, eventId).trackedEventStatus;
  }

  public deferredMatchStart(matchId: string): MatchStarted | undefined {
    if (!isBoundedString(matchId, 256)) return undefined;
    const start = this.materialize().deferredMatchStarts.find(
      (candidate) => candidate.matchId === matchId,
    );
    return start === undefined ? undefined : cloneEvent(start) as MatchStarted;
  }

  private materialize(
    playerId?: string,
    trackedEventId?: string,
  ): CompetitionMaterialization {
    let trackedEventStatus: CompetitionEventStatus = "unknown";
    const markSeen = (event: CompetitionEvent): void => {
      if (event.eventId === trackedEventId) trackedEventStatus = "rejected";
    };
    const markEffective = (event: CompetitionEvent): void => {
      if (event.eventId === trackedEventId) trackedEventStatus = "effective";
    };
    const markDeferred = (event: CompetitionEvent): void => {
      if (event.eventId === trackedEventId) trackedEventStatus = "deferred";
    };
    const markRejected = (event: CompetitionEvent): void => {
      if (event.eventId === trackedEventId) trackedEventStatus = "rejected";
    };
    const challenges = new Map<string, MutableChallenge>();
    const pairings = new Map<string, MutablePairing>();
    const matches = new Map<string, MutablePairing>();
    const commitments = new Map<string, PlayerCompetitionActivity>();
    const latestCommitmentOrderByPlayer = new Map<string, number>();
    const latestCompletedBySeries = new Map<string, MutablePairing>();
    const rematches = new Map<string, MutableRematch>();
    const practiceRuns = new Set<string>();
    const practiceBests = new Map<string, PracticeCompleted>();
    const practiceBestOrderByPlayer = new Map<string, number>();
    const pendingStarts: MatchStarted[] = [];
    const pendingLeaves: PairingLeft[] = [];
    const pendingTerminals: Array<{
      event: MatchFinished | MatchConceded;
      order: number;
    }> = [];
    const rejectedClaims: RejectedClaimView[] = [];
    const invalidatePendingRematches = (actorId: string, exceptKey?: string): void => {
      for (const [key, rematch] of rematches) {
        if (
          key !== exceptKey &&
          rematch.status === "pending" &&
          (rematch.seatA.id === actorId || rematch.seatB.id === actorId)
        ) {
          rematch.status = "invalidated";
          rematch.requestedBy.clear();
        }
      }
    };
    const commitRematch = (
      rematch: MutableRematch,
      pairingId: string,
      eventOrder: number,
    ): boolean => {
      if (
        rematch.status !== "pending" ||
        commitments.has(rematch.seatA.id) ||
        commitments.has(rematch.seatB.id) ||
        pairings.has(pairingId)
      ) {
        return false;
      }
      rematch.status = "paired";
      rematch.pairingId = pairingId;
      invalidatePendingRematches(rematch.seatA.id, rematchKey(rematch.seriesId, rematch.round));
      invalidatePendingRematches(rematch.seatB.id, rematchKey(rematch.seriesId, rematch.round));
      const pairing: MutablePairing = {
        pairingId,
        source: "rematch",
        seriesId: rematch.seriesId,
        round: rematch.round,
        matchId: `${rematch.seriesId}:round:${rematch.round}`,
        seatA: { ...rematch.seatA },
        seatB: { ...rematch.seatB },
        status: "starting",
        readyByPlayer: {
          [rematch.seatA.id]: false,
          [rematch.seatB.id]: false,
        },
        runtimeSessionByPlayer: {},
        resultVariants: new Map(),
      };
      pairings.set(pairing.pairingId, pairing);
      const activity = pairingActivity(pairing, "starting");
      commitments.set(pairing.seatA.id, activity);
      commitments.set(pairing.seatB.id, activity);
      latestCommitmentOrderByPlayer.set(pairing.seatA.id, eventOrder);
      latestCommitmentOrderByPlayer.set(pairing.seatB.id, eventOrder);
      retryPendingStarts();
      return true;
    };
    const tryCommitFinish = (
      event: MatchFinished,
      eventOrder: number,
    ): "committed" | "deferred" | "rejected" => {
      const pairing = matches.get(event.matchId);
      if (pairing === undefined) {
        markDeferred(event);
        return "deferred";
      }
      if (
        pairing.started?.eventId !== event.startedEventId ||
        !actorInPairing(pairing, event.actor.id) ||
        !resultMatchesPairing(event.result, pairing)
      ) {
        markRejected(event);
        return "rejected";
      }
      if (pairing.status === "completed") {
        const accepted = pairing.firstFinish;
        const acceptedIsConnectionLoss = accepted?.result.outcome === "desync" &&
          accepted.result.reason === "connection-lost";
        const candidateIsConnectionLoss = event.result.outcome === "desync" &&
          event.result.reason === "connection-lost";
        // A receive-only fallback is deliberately subordinate to a terminal
        // authority from the committed simulation or an explicit participant
        // concession. This remains convergent even if the fallback's lower
        // logical clock made it materialize first.
        if (accepted !== undefined && acceptedIsConnectionLoss && !candidateIsConnectionLoss) {
          markRejected(accepted);
          pairing.firstFinish = event;
          pairing.firstFinishOrder = eventOrder;
          pairing.resultVariants.clear();
          pairing.resultVariants.set(
            stableJson(event.result),
            cloneMatchResult(event.result),
          );
          markEffective(event);
          return "committed";
        }
        markRejected(event);
        return "rejected";
      }
      const fingerprint = stableJson(event.result);
      pairing.resultVariants.set(fingerprint, cloneMatchResult(event.result));
      if (pairing.resultVariants.size > MAX_RESULT_VARIANTS_PER_MATCH) {
        const orderedFingerprints = [...pairing.resultVariants.keys()].sort(compareCodeUnits);
        const discarded = orderedFingerprints[orderedFingerprints.length - 1];
        if (discarded !== undefined) pairing.resultVariants.delete(discarded);
      }
      if (pairing.status === "live") {
        pairing.status = "completed";
        pairing.firstFinish = event;
        pairing.firstFinishOrder = eventOrder;
        commitments.delete(pairing.seatA.id);
        commitments.delete(pairing.seatB.id);
        if (pairing.challengeId !== undefined) {
          const challenge = challenges.get(pairing.challengeId);
          if (challenge !== undefined) challenge.status = "completed";
        }
        const previousRound = latestCompletedBySeries.get(pairing.seriesId);
        if (previousRound === undefined || previousRound.round < pairing.round) {
          latestCompletedBySeries.set(pairing.seriesId, pairing);
        }
        markEffective(event);
      }
      return "committed";
    };
    const tryCommitConcession = (
      event: MatchConceded,
      eventOrder: number,
    ): "committed" | "deferred" | "rejected" => {
      const pairing = matches.get(event.matchId);
      if (pairing === undefined) {
        markDeferred(event);
        return "deferred";
      }
      const result = concessionResult(event, pairing);
      if (result === undefined || pairing.started?.eventId !== event.startedEventId) {
        markRejected(event);
        return "rejected";
      }
      const finish: MatchFinished = {
        ...event,
        kind: "match-finished",
        result,
      };
      return tryCommitFinish(finish, eventOrder);
    };
    const retryPendingTerminals = (): void => {
      for (let index = 0; index < pendingTerminals.length;) {
        const pending = pendingTerminals[index]!;
        const outcome = pending.event.kind === "match-finished"
          ? tryCommitFinish(pending.event, pending.order)
          : tryCommitConcession(pending.event, pending.order);
        if (outcome === "deferred") {
          index += 1;
        } else {
          pendingTerminals.splice(index, 1);
        }
      }
    };
    const tryCommitStart = (event: MatchStarted): "committed" | "deferred" | "rejected" => {
      const pairing = pairings.get(event.pairingId);
      if (pairing === undefined) {
        markRejected(event);
        return "rejected";
      }
      if (
        pairing.status !== "starting" ||
        matches.has(event.matchId) ||
        event.actor.id !== pairing.seatA.id ||
        event.seriesId !== pairing.seriesId ||
        event.round !== pairing.round ||
        event.matchId !== pairing.matchId ||
        event.rulesHash !== this.currentRulesHash ||
        event.seatAPlayerId !== pairing.seatA.id ||
        event.seatBPlayerId !== pairing.seatB.id ||
        [...pairings.values()].some((other) =>
          other !== pairing &&
          other.seriesId === event.seriesId &&
          other.started?.seedHash === event.seedHash
        )
      ) {
        markRejected(event);
        return "rejected";
      }
      if (
        event.seatASessionId !== pairing.runtimeSessionByPlayer[pairing.seatA.id] ||
        event.seatBSessionId !== pairing.runtimeSessionByPlayer[pairing.seatB.id] ||
        pairing.readyByPlayer[pairing.seatA.id] !== true ||
        pairing.readyByPlayer[pairing.seatB.id] !== true
      ) {
        markDeferred(event);
        return "deferred";
      }
      pairing.status = "live";
      pairing.started = event;
      matches.set(pairing.matchId, pairing);
      if (pairing.challengeId !== undefined) {
        const challenge = challenges.get(pairing.challengeId);
        if (challenge !== undefined) challenge.status = "live";
      }
      const activity = pairingActivity(pairing, "live");
      commitments.set(pairing.seatA.id, activity);
      commitments.set(pairing.seatB.id, activity);
      markEffective(event);
      retryPendingTerminals();
      return "committed";
    };
    const retryPendingStarts = (): void => {
      for (let index = 0; index < pendingStarts.length;) {
        const outcome = tryCommitStart(pendingStarts[index]!);
        if (outcome === "deferred") {
          index += 1;
        } else {
          pendingStarts.splice(index, 1);
        }
      }
    };
    const tryCommitLeave = (
      event: PairingLeft,
    ): "committed" | "deferred" | "rejected" => {
      const pairing = pairings.get(event.pairingId);
      if (
        pairing === undefined ||
        pairing.status !== "starting" ||
        !actorInPairing(pairing, event.actor.id)
      ) {
        markRejected(event);
        return "rejected";
      }
      const claimedRuntimeSessionId = pairing.runtimeSessionByPlayer[event.actor.id];
      if (claimedRuntimeSessionId === undefined) {
        markDeferred(event);
        return "deferred";
      }
      if (claimedRuntimeSessionId !== event.runtimeSessionId) {
        markRejected(event);
        return "rejected";
      }
      pairings.delete(pairing.pairingId);
      commitments.delete(pairing.seatA.id);
      commitments.delete(pairing.seatB.id);
      if (pairing.source === "challenge" && pairing.challengeId !== undefined) {
        const challenge = challenges.get(pairing.challengeId);
        if (challenge !== undefined && challenge.pairingId === pairing.pairingId) {
          if (event.actor.id === pairing.seatB.id) {
            challenge.status = "waiting";
            challenge.vacancyId = `${event.eventId}:vacancy`;
            delete challenge.pairingId;
            commitments.set(pairing.seatA.id, {
              kind: "waiting",
              challengeId: challenge.challengeId,
            });
          } else {
            challenges.delete(challenge.challengeId);
          }
        }
      } else if (pairing.source === "rematch") {
        const rematch = rematches.get(rematchKey(pairing.seriesId, pairing.round));
        if (rematch?.pairingId === pairing.pairingId) rematch.status = "invalidated";
      }
      markEffective(event);
      return "committed";
    };
    const retryPendingLeaves = (): void => {
      for (let index = 0; index < pendingLeaves.length;) {
        if (tryCommitLeave(pendingLeaves[index]!) === "deferred") {
          index += 1;
        } else {
          pendingLeaves.splice(index, 1);
        }
      }
    };
    // Webxdc serials are replica-local replay cursors. The application tuple is
    // the portable total order used by every materialized view.
    const orderedEvents = [...this.eventsById.values()].sort(compareEvents);
    for (const [eventIndex, event] of orderedEvents.entries()) {
      markSeen(event);
      const eventOrder = eventIndex + 1;
      if (event.kind === "practice-completed") {
        const runKey = `${event.actor.id.length}:${event.actor.id}${event.rulesHash.length}:${event.rulesHash}${event.runId}`;
        if (practiceRuns.has(runKey)) continue;
        practiceRuns.add(runKey);
        if (event.rulesHash !== this.currentRulesHash) continue;
        markEffective(event);
        const previous = practiceBests.get(event.actor.id);
        const previousOrder = practiceBestOrderByPlayer.get(event.actor.id);
        if (
          previous === undefined ||
          event.score > previous.score ||
          (event.score === previous.score &&
            (previousOrder === undefined || eventOrder < previousOrder))
        ) {
          practiceBests.set(event.actor.id, event);
          practiceBestOrderByPlayer.set(event.actor.id, eventOrder);
        }
        continue;
      }
      if (event.kind === "challenge-created") {
        if (
          event.rulesHash !== this.currentRulesHash ||
          challenges.has(event.challengeId) ||
          commitments.has(event.actor.id)
        ) {
          continue;
        }
        invalidatePendingRematches(event.actor.id);
        challenges.set(event.challengeId, {
          challengeId: event.challengeId,
          creator: { ...event.actor },
          rulesHash: event.rulesHash,
          vacancyId: event.vacancyId,
          status: "waiting",
        });
        commitments.set(event.actor.id, {
          kind: "waiting",
          challengeId: event.challengeId,
        });
        latestCommitmentOrderByPlayer.set(event.actor.id, eventOrder);
        markEffective(event);
        continue;
      }
      if (event.kind === "pairing-left") {
        if (tryCommitLeave(event) === "deferred") pendingLeaves.push(event);
        continue;
      }
      if (event.kind === "challenge-cancelled") {
        const challenge = challenges.get(event.challengeId);
        if (
          challenge === undefined ||
          challenge.creator.id !== event.actor.id ||
          challenge.status === "live" ||
          challenge.status === "completed"
        ) {
          continue;
        }
        commitments.delete(challenge.creator.id);
        if (challenge.pairingId !== undefined) {
          const pairing = pairings.get(challenge.pairingId);
          if (pairing !== undefined) {
            commitments.delete(pairing.seatB.id);
            pairings.delete(pairing.pairingId);
          }
        }
        challenges.delete(challenge.challengeId);
        markEffective(event);
        continue;
      }
      if (event.kind === "runtime-claimed") {
        const pairing = pairings.get(event.pairingId);
        if (
          pairing === undefined ||
          pairing.status !== "starting" ||
          !actorInPairing(pairing, event.actor.id)
        ) {
          continue;
        }
        pairing.runtimeSessionByPlayer[event.actor.id] = event.runtimeSessionId;
        pairing.readyByPlayer[event.actor.id] = false;
        markEffective(event);
        retryPendingLeaves();
        retryPendingStarts();
        continue;
      }
      if (event.kind === "ready-changed") {
        const pairing = pairings.get(event.pairingId);
        if (
          pairing === undefined ||
          pairing.status !== "starting" ||
          !actorInPairing(pairing, event.actor.id) ||
          pairing.runtimeSessionByPlayer[event.actor.id] !== event.runtimeSessionId
        ) {
          continue;
        }
        pairing.readyByPlayer[event.actor.id] = event.ready;
        markEffective(event);
        retryPendingStarts();
        continue;
      }
      if (event.kind === "match-started") {
        if (tryCommitStart(event) === "deferred") pendingStarts.push(event);
        continue;
      }
      if (event.kind === "match-finished") {
        if (tryCommitFinish(event, eventOrder) === "deferred") {
          pendingTerminals.push({ event, order: eventOrder });
        }
        continue;
      }
      if (event.kind === "match-conceded") {
        if (tryCommitConcession(event, eventOrder) === "deferred") {
          pendingTerminals.push({ event, order: eventOrder });
        }
        continue;
      }
      if (event.kind === "rematch-requested") {
        const latest = latestCompletedBySeries.get(event.seriesId);
        const completedOrder = latest?.firstFinishOrder;
        if (
          latest === undefined ||
          completedOrder === undefined ||
          latest.matchId !== event.afterMatchId ||
          event.round !== latest.round + 1 ||
          !actorInPairing(latest, event.actor.id) ||
          commitments.has(latest.seatA.id) ||
          commitments.has(latest.seatB.id) ||
          (latestCommitmentOrderByPlayer.get(latest.seatA.id) ?? 0) > completedOrder ||
          (latestCommitmentOrderByPlayer.get(latest.seatB.id) ?? 0) > completedOrder
        ) {
          continue;
        }
        const key = rematchKey(event.seriesId, event.round);
        let rematch = rematches.get(key);
        if (rematch === undefined) {
          rematch = {
            seriesId: event.seriesId,
            afterMatchId: event.afterMatchId,
            round: event.round,
            seatA: { ...latest.seatA },
            seatB: { ...latest.seatB },
            requestedBy: new Set(),
            requestEventIdByPlayer: {},
            status: "pending",
          };
          rematches.set(key, rematch);
        }
        if (
          rematch.status !== "pending" ||
          rematch.afterMatchId !== event.afterMatchId ||
          rematch.requestedBy.has(event.actor.id)
        ) {
          continue;
        }
        rematch.requestedBy.add(event.actor.id);
        rematch.requestEventIdByPlayer[event.actor.id] = event.eventId;
        markEffective(event);
        if (rematch.requestedBy.size < 2) continue;
        if (commitRematch(rematch, event.eventId, eventOrder)) markEffective(event);
        continue;
      }
      if (event.kind === "rematch-accepted") {
        const latest = latestCompletedBySeries.get(event.seriesId);
        const rematch = rematches.get(rematchKey(event.seriesId, event.round));
        if (
          latest === undefined ||
          latest.matchId !== event.afterMatchId ||
          event.round !== latest.round + 1 ||
          rematch === undefined ||
          rematch.status !== "pending" ||
          rematch.afterMatchId !== event.afterMatchId ||
          !actorInPairing(latest, event.actor.id) ||
          commitments.has(rematch.seatA.id) ||
          commitments.has(rematch.seatB.id)
        ) {
          continue;
        }
        const requesterId = event.actor.id === rematch.seatA.id
          ? rematch.seatB.id
          : rematch.seatA.id;
        if (rematch.requestEventIdByPlayer[requesterId] !== event.requestedEventId) {
          continue;
        }
        if (commitRematch(rematch, event.eventId, eventOrder)) markEffective(event);
        continue;
      }
      if (event.kind === "rematch-withdrawn") {
        const rematch = rematches.get(rematchKey(event.seriesId, event.round));
        if (
          rematch === undefined ||
          rematch.status === "invalidated" ||
          (event.actor.id !== rematch.seatA.id && event.actor.id !== rematch.seatB.id)
        ) {
          continue;
        }
        if (rematch.status === "paired" && rematch.pairingId !== undefined) {
          const pairing = pairings.get(rematch.pairingId);
          if (pairing?.status === "starting") {
            pairings.delete(pairing.pairingId);
            commitments.delete(pairing.seatA.id);
            commitments.delete(pairing.seatB.id);
          }
        }
        rematch.status = "invalidated";
        rematch.requestedBy.clear();
        markEffective(event);
        continue;
      }
      if (event.kind !== "challenge-claimed") continue;
      const challenge = challenges.get(event.challengeId);
      let rejection: RejectedClaimView["reason"] | undefined;
      if (challenge === undefined) rejection = "challenge-unavailable";
      else if (challenge.creator.id === event.actor.id) rejection = "self-join";
      else if (commitments.has(event.actor.id)) rejection = "already-committed";
      else if (challenge.vacancyId !== event.vacancyId) rejection = "stale-vacancy";
      else if (challenge.status !== "waiting") rejection = "vacancy-claimed";
      if (rejection !== undefined) {
        rejectedClaims.push({
          claimEventId: event.eventId,
          challengeId: event.challengeId,
          vacancyId: event.vacancyId,
          claimant: { ...event.actor },
          reason: rejection,
          ...(rejection === "vacancy-claimed" && challenge?.pairingId !== undefined
            ? { winningPairingId: challenge.pairingId }
            : {}),
        });
        continue;
      }
      if (challenge === undefined) continue;
      const creatorCommitment = commitments.get(challenge.creator.id);
      if (
        creatorCommitment?.kind !== "waiting" ||
        creatorCommitment.challengeId !== challenge.challengeId
      ) {
        rejectedClaims.push({
          claimEventId: event.eventId,
          challengeId: event.challengeId,
          vacancyId: event.vacancyId,
          claimant: { ...event.actor },
          reason: "challenge-unavailable",
        });
        continue;
      }
      const pairingId = event.eventId;
      invalidatePendingRematches(event.actor.id);
      const seriesId = challenge.challengeId;
      const round = 1;
      const matchId = `${seriesId}:round:${round}`;
      const pairing: MutablePairing = {
        pairingId,
        source: "challenge",
        challengeId: challenge.challengeId,
        seriesId,
        round,
        matchId,
        seatA: { ...challenge.creator },
        seatB: { ...event.actor },
        readyByPlayer: {
          [challenge.creator.id]: false,
          [event.actor.id]: false,
        },
        runtimeSessionByPlayer: {},
        status: "starting",
        resultVariants: new Map(),
      };
      pairings.set(pairingId, pairing);
      challenge.status = "starting";
      challenge.pairingId = pairingId;
      const activity = pairingActivity(pairing, "starting");
      commitments.set(challenge.creator.id, activity);
      commitments.set(event.actor.id, activity);
      latestCommitmentOrderByPlayer.set(challenge.creator.id, eventOrder);
      latestCommitmentOrderByPlayer.set(event.actor.id, eventOrder);
      markEffective(event);
    }
    retryPendingLeaves();
    if (
      (trackedEventStatus as CompetitionEventStatus) === "deferred" &&
      trackedEventId !== undefined
    ) {
      const tracked = this.eventsById.get(trackedEventId);
      if (tracked?.kind === "match-started") {
        const pairing = pairings.get(tracked.pairingId);
        if (pairing?.status !== "starting") trackedEventStatus = "rejected";
      } else if (tracked?.kind === "match-finished" || tracked?.kind === "match-conceded") {
        const potentialStart = pendingStarts.find((start) =>
          start.eventId === tracked.startedEventId && start.matchId === tracked.matchId
        );
        const pairing = potentialStart === undefined
          ? undefined
          : pairings.get(potentialStart.pairingId);
        if (pairing?.status !== "starting") trackedEventStatus = "rejected";
      }
    }
    const openChallenges = [...challenges.values()]
      .filter((challenge) => challenge.status === "waiting")
      .map((challenge) => ({
        challengeId: challenge.challengeId,
        creator: { ...challenge.creator },
        rulesHash: challenge.rulesHash,
        vacancyId: challenge.vacancyId,
      }));
    const startingPairings: StartingPairingView[] = [...pairings.values()]
      .filter((pairing) => pairing.status === "starting")
      .map((pairing) => ({
        pairingId: pairing.pairingId,
        source: pairing.source,
        ...(pairing.challengeId === undefined ? {} : { challengeId: pairing.challengeId }),
        seriesId: pairing.seriesId,
        round: pairing.round,
        matchId: pairing.matchId,
        seatA: { ...pairing.seatA },
        seatB: { ...pairing.seatB },
        readyByPlayer: { ...pairing.readyByPlayer },
        runtimeSessionByPlayer: { ...pairing.runtimeSessionByPlayer },
      }));
    const liveMatches: LiveMatchView[] = [...pairings.values()]
      .filter((pairing): pairing is MutablePairing & { started: MatchStarted } =>
        pairing.status === "live" && pairing.started !== undefined
      )
      .map((pairing) => ({
        pairingId: pairing.pairingId,
        source: pairing.source,
        ...(pairing.challengeId === undefined ? {} : { challengeId: pairing.challengeId }),
        seriesId: pairing.seriesId,
        round: pairing.round,
        matchId: pairing.matchId,
        seatA: { ...pairing.seatA },
        seatB: { ...pairing.seatB },
        runtimeSessionByPlayer: { ...pairing.runtimeSessionByPlayer },
        startedEventId: pairing.started.eventId,
        start: cloneEvent(pairing.started) as MatchStarted,
      }));
    const completed = [...pairings.values()]
      .filter((pairing): pairing is MutablePairing & {
        firstFinish: MatchFinished;
        firstFinishOrder: number;
      } =>
        pairing.status === "completed" &&
        pairing.firstFinish !== undefined &&
        pairing.firstFinishOrder !== undefined
      );
    const recentResults = completed
      .sort((left, right) =>
        right.firstFinishOrder - left.firstFinishOrder ||
        compareCodeUnits(left.matchId, right.matchId)
      )
      .map(materializeResult)
      .filter((entry): entry is CompetitionResultView => entry !== undefined)
      .slice(0, 20);
    const officialResults = completed
      .sort((left, right) =>
        left.firstFinishOrder - right.firstFinishOrder ||
        compareCodeUnits(left.matchId, right.matchId)
      )
      .map(materializeResult)
      .filter((entry): entry is CompetitionResultView => entry !== undefined);
    const standingsByPlayer = new Map<string, {
      player: CompetitionActor;
      wins: number;
      losses: number;
      draws: number;
    }>();
    const headToHeadByPair = new Map<string, {
      playerIds: [string, string];
      players: [CompetitionActor, CompetitionActor];
      winsByPlayer: Record<string, number>;
      draws: number;
    }>();
    const seriesScoresById = new Map<string, SeriesScoreView>();
    for (const entry of officialResults) {
      const result = entry.result;
      if (entry.conflicted || result.outcome === "desync") continue;
      const firstPlayer = result.players[0];
      const secondPlayer = result.players[1];
      if (firstPlayer === undefined || secondPlayer === undefined) continue;
      const previousSeriesScore = seriesScoresById.get(entry.seriesId);
      const seriesScore: SeriesScoreView = previousSeriesScore ?? {
        seriesId: entry.seriesId,
        players: [{ ...firstPlayer }, { ...secondPlayer }],
        winsByPlayer: { [firstPlayer.id]: 0, [secondPlayer.id]: 0 },
        draws: 0,
        completedRounds: 0,
        latestRound: 0,
      };
      const winsByPlayer = { ...seriesScore.winsByPlayer };
      let seriesDraws = seriesScore.draws;
      if (result.outcome === "draw") {
        seriesDraws += 1;
      } else {
        const seriesWinner = result.outcome === "seat-a" ? firstPlayer.id : secondPlayer.id;
        winsByPlayer[seriesWinner] = (winsByPlayer[seriesWinner] ?? 0) + 1;
      }
      seriesScoresById.set(entry.seriesId, {
        seriesId: entry.seriesId,
        players: [{ ...firstPlayer }, { ...secondPlayer }],
        winsByPlayer,
        draws: seriesDraws,
        completedRounds: seriesScore.completedRounds + 1,
        latestRound: Math.max(seriesScore.latestRound, entry.round),
      });
      for (const player of [firstPlayer, secondPlayer]) {
        const standing = standingsByPlayer.get(player.id) ?? {
          player: { ...player },
          wins: 0,
          losses: 0,
          draws: 0,
        };
        standing.player = { ...player };
        standingsByPlayer.set(player.id, standing);
      }
      const [firstId, secondId] = [firstPlayer.id, secondPlayer.id].sort(compareCodeUnits) as [string, string];
      const playersById = new Map(result.players.map((player) => [player.id, player]));
      const key = pairKey(firstId, secondId);
      const tally = headToHeadByPair.get(key) ?? {
        playerIds: [firstId, secondId],
        players: [{ ...playersById.get(firstId)! }, { ...playersById.get(secondId)! }],
        winsByPlayer: { [firstId]: 0, [secondId]: 0 },
        draws: 0,
      };
      tally.players = [{ ...playersById.get(firstId)! }, { ...playersById.get(secondId)! }];
      if (result.outcome === "draw") {
        standingsByPlayer.get(firstPlayer.id)!.draws += 1;
        standingsByPlayer.get(secondPlayer.id)!.draws += 1;
        tally.draws += 1;
      } else {
        const winner = result.outcome === "seat-a" ? firstPlayer.id : secondPlayer.id;
        const loser = result.outcome === "seat-a" ? secondPlayer.id : firstPlayer.id;
        standingsByPlayer.get(winner)!.wins += 1;
        standingsByPlayer.get(loser)!.losses += 1;
        tally.winsByPlayer[winner] = (tally.winsByPlayer[winner] ?? 0) + 1;
      }
      headToHeadByPair.set(key, tally);
    }
    const standings: StandingView[] = [...standingsByPlayer.values()]
      .map((standing) => {
        const games = standing.wins + standing.losses + standing.draws;
        return { ...standing, games, winRate: games === 0 ? 0 : standing.wins / games };
      })
      .sort((left, right) =>
        right.wins - left.wins ||
        right.winRate - left.winRate ||
        compareCodeUnits(left.player.displayName, right.player.displayName) ||
        compareCodeUnits(left.player.id, right.player.id)
      );
    const headToHead: HeadToHeadView[] = [...headToHeadByPair.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, tally]) => ({
        playerIds: [...tally.playerIds],
        players: [{ ...tally.players[0] }, { ...tally.players[1] }],
        winsByPlayer: { ...tally.winsByPlayer },
        draws: tally.draws,
      }));
    const seriesScores = [...seriesScoresById.values()]
      .sort((left, right) => compareCodeUnits(left.seriesId, right.seriesId));
    const pendingRematches: PendingRematchView[] = [...rematches.values()]
      .filter((rematch) => rematch.status === "pending" && rematch.requestedBy.size > 0)
      .map((rematch) => ({
        seriesId: rematch.seriesId,
        afterMatchId: rematch.afterMatchId,
        round: rematch.round,
        seatA: { ...rematch.seatA },
        seatB: { ...rematch.seatB },
        requestedByPlayerIds: [...rematch.requestedBy].sort(compareCodeUnits),
        requestEventIdByPlayer: { ...rematch.requestEventIdByPlayer },
      }));
    const rankedPractice = [...practiceBests.values()]
      .sort((left, right) =>
        right.score - left.score ||
        compareEvents(left, right) ||
        compareCodeUnits(left.eventId, right.eventId) ||
        compareCodeUnits(left.actor.id, right.actor.id)
      )
      .map<PracticeLeaderboardEntry>((entry, index) => ({
        rank: index + 1,
        player: { ...entry.actor },
        score: entry.score,
        eventId: entry.eventId,
        runId: entry.runId,
        durationTicks: entry.durationTicks,
        finalLevel: entry.finalLevel,
        finalStats: { ...entry.finalStats },
      }));
    const personalBest = playerId === undefined
      ? null
      : rankedPractice.find((entry) => entry.player.id === playerId) ?? null;
    const practice: PracticeLeaderboardView = {
      rulesHash: this.currentRulesHash,
      totalPlayers: rankedPractice.length,
      leaderboard: rankedPractice.slice(0, 10),
      pinned: personalBest !== null && personalBest.rank > 10 ? personalBest : null,
      personalBest,
      record: rankedPractice[0] ?? null,
    };
    return {
      trackedEventStatus,
      deferredMatchStarts: pendingStarts
        .filter((start) => pairings.get(start.pairingId)?.status === "starting")
        .map((start) => cloneEvent(start) as MatchStarted),
      view: {
        counts: {
          waiting: openChallenges.length,
          starting: startingPairings.length,
          live: liveMatches.length,
          completed: completed.length,
        },
        activity: playerId === undefined
          ? { kind: "idle" }
          : commitments.get(playerId) ?? { kind: "idle" },
        openChallenges,
        startingPairings,
        liveMatches,
        recentResults,
        standings,
        headToHead,
        seriesScores,
        pendingRematches,
        rejectedClaims: playerId === undefined
          ? []
          : rejectedClaims.filter((claim) => claim.claimant.id === playerId),
        practice,
      },
    };
  }
}
