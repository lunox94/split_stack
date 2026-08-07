export const CHAT_INFO_MAX_CHARACTERS = 50;
export const CHAT_SUMMARY_MAX_CHARACTERS = 20;

const MAX_ROUTE_ID_CHARACTERS = 256;

export interface ChatActivityCounts {
  waiting: number;
  live: number;
}

export interface ChatUpdateMetadata {
  summary: string;
  info?: string;
  href?: string;
  notify?: Record<string, string>;
}

export interface ProjectedChatUpdate<T> extends ChatUpdateMetadata {
  payload: T;
}

export interface ChallengeFeedbackInput {
  actorName: string;
  challengeId: string;
  activity: ChatActivityCounts;
}

export interface ChallengeJoinedFeedbackInput {
  joinerName: string;
  creatorId: string;
  challengeId: string;
  activity: ChatActivityCounts;
}

export interface MatchStartedFeedbackInput {
  seatAName: string;
  seatBName: string;
  matchId: string;
  activity: ChatActivityCounts;
}

export interface ChatResultPlayer {
  id: string;
  displayName: string;
  score: number;
}

export interface HeadToHeadScore {
  seatAWins: number;
  seatBWins: number;
}

export interface MatchResultFeedbackInput {
  matchId: string;
  seatA: ChatResultPlayer;
  seatB: ChatResultPlayer;
  outcome: "seat-a" | "seat-b" | "draw" | "neutral";
  reason?: "connection-lost" | "concession";
  headToHead: HeadToHeadScore;
  activity: ChatActivityCounts;
}

export interface RematchRequestedFeedbackInput {
  requesterName: string;
  opponentId: string;
  matchId: string;
  activity: ChatActivityCounts;
}

export interface PracticeRecordFeedbackInput {
  playerName: string;
  score: number;
  previousChatRecord: number;
  rulesHash: string;
  activity: ChatActivityCounts;
}

function assertCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertId(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ROUTE_ID_CHARACTERS
  ) {
    throw new RangeError(`${label} must contain 1-${MAX_ROUTE_ID_CHARACTERS} characters`);
  }
  return value;
}

function inlineText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function displayName(value: string, maximum = 12): string {
  const normalized = inlineText(value);
  return truncate(normalized.length === 0 ? "Player" : normalized, maximum);
}

function infoText(value: string): string {
  return truncate(inlineText(value), CHAT_INFO_MAX_CHARACTERS);
}

function compactCounter(value: number): string {
  assertCounter(value, "count");
  if (value < 1_000) return String(value);
  const units = ["k", "m", "b", "t", "q"] as const;
  let unitIndex = -1;
  let divisor = 1;
  while (unitIndex + 1 < units.length && value >= divisor * 1_000) {
    unitIndex += 1;
    divisor *= 1_000;
  }
  const scaled = value / divisor;
  const precision = scaled < 10 ? 10 : 1;
  const compact = Math.floor(scaled * precision) / precision;
  return `${compact}${units[unitIndex] ?? "q"}`;
}

function exactNumber(value: number, label: string): string {
  return assertCounter(value, label)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function routeHref(route: string, id: string, label: string): string {
  return `index.html#${route}/${encodeURIComponent(assertId(id, label))}`;
}

function notifyOnly(playerIds: readonly string[], message: string): Record<string, string> {
  const notifications: Record<string, string> = {};
  for (const playerId of playerIds) {
    Object.defineProperty(notifications, assertId(playerId, "notification player ID"), {
      configurable: true,
      enumerable: true,
      value: message,
      writable: true,
    });
  }
  return notifications;
}

export function tournamentSummary(activity: ChatActivityCounts): string {
  const summary = `${compactCounter(activity.waiting)} wait · ${compactCounter(activity.live)} live`;
  return truncate(summary, CHAT_SUMMARY_MAX_CHARACTERS);
}

export function challengeHref(challengeId: string): string {
  return routeHref("lobby/challenge", challengeId, "challenge ID");
}

export function liveMatchHref(matchId: string): string {
  return routeHref("match", matchId, "match ID");
}

export function matchResultHref(matchId: string): string {
  return routeHref("result", matchId, "match ID");
}

export function practiceLeaderboardHref(rulesHash: string): string {
  return routeHref("practice/leaderboard", rulesHash, "rules hash");
}

export function projectChatUpdate<T>(
  payload: T,
  metadata: ChatUpdateMetadata,
): ProjectedChatUpdate<T> {
  return {
    payload,
    ...metadata,
    ...(metadata.notify === undefined ? {} : { notify: { ...metadata.notify } }),
  };
}

export function challengeOpenedFeedback(
  input: ChallengeFeedbackInput,
): ChatUpdateMetadata {
  return {
    info: infoText(`${displayName(input.actorName)} is waiting for an opponent.`),
    href: challengeHref(input.challengeId),
    summary: tournamentSummary(input.activity),
  };
}

export function challengeCancelledFeedback(
  input: ChallengeFeedbackInput,
): ChatUpdateMetadata {
  return {
    summary: tournamentSummary(input.activity),
  };
}

export function challengeJoinedFeedback(
  input: ChallengeJoinedFeedbackInput,
): ChatUpdateMetadata {
  const notification = infoText(`${displayName(input.joinerName)} joined your challenge`);
  return {
    href: challengeHref(input.challengeId),
    summary: tournamentSummary(input.activity),
    notify: notifyOnly([input.creatorId], notification),
  };
}

export function matchStartedFeedback(
  input: MatchStartedFeedbackInput,
): ChatUpdateMetadata {
  return {
    info: infoText(
      `${displayName(input.seatAName)} vs ${displayName(input.seatBName)} started.`,
    ),
    href: liveMatchHref(input.matchId),
    summary: tournamentSummary(input.activity),
  };
}

function resultInfo(input: MatchResultFeedbackInput): string {
  if (input.reason === "concession") {
    if (input.outcome !== "seat-a" && input.outcome !== "seat-b") {
      throw new RangeError("A concession must name a winning seat");
    }
    const winner = input.outcome === "seat-a" ? input.seatA : input.seatB;
    const conceder = input.outcome === "seat-a" ? input.seatB : input.seatA;
    return infoText(
      `${displayName(conceder.displayName)} conceded · ${displayName(winner.displayName)} wins`,
    );
  }
  if (input.outcome === "neutral") {
    return infoText("No result · standings unchanged");
  }
  const seatAFirst = input.outcome !== "seat-b";
  const first = seatAFirst ? input.seatA : input.seatB;
  const second = seatAFirst ? input.seatB : input.seatA;
  const firstWins = seatAFirst
    ? input.headToHead.seatAWins
    : input.headToHead.seatBWins;
  const secondWins = seatAFirst
    ? input.headToHead.seatBWins
    : input.headToHead.seatAWins;
  const status = input.outcome === "draw" ? " · Draw" : "";
  const build = (
    maximumNameLength: number,
    formatNumber: (value: number, label: string) => string,
  ): string =>
    `${displayName(first.displayName, maximumNameLength)} ${formatNumber(first.score, "score")}` +
    `–${formatNumber(second.score, "score")} ${displayName(second.displayName, maximumNameLength)}` +
    `${status} · H2H ${formatNumber(firstWins, "head-to-head wins")}` +
    `–${formatNumber(secondWins, "head-to-head wins")}`;
  const exact = inlineText(build(10, exactNumber));
  if (Array.from(exact).length <= CHAT_INFO_MAX_CHARACTERS) return exact;
  return infoText(build(6, (value, label) => {
    assertCounter(value, label);
    return compactCounter(value);
  }));
}

export function matchResultFeedback(
  input: MatchResultFeedbackInput,
): ChatUpdateMetadata {
  assertId(input.seatA.id, "Seat A player ID");
  assertId(input.seatB.id, "Seat B player ID");
  if (input.seatA.id === input.seatB.id) {
    throw new RangeError("Result players must be different");
  }
  if (input.outcome === "neutral" && input.reason === "connection-lost") {
    return { summary: tournamentSummary(input.activity) };
  }
  const info = resultInfo(input);
  return {
    info,
    href: matchResultHref(input.matchId),
    summary: tournamentSummary(input.activity),
    notify: notifyOnly([input.seatA.id, input.seatB.id], info),
  };
}

export function rematchRequestedFeedback(
  input: RematchRequestedFeedbackInput,
): ChatUpdateMetadata {
  const notification = infoText(`${displayName(input.requesterName)} requested a rematch`);
  return {
    href: matchResultHref(input.matchId),
    summary: tournamentSummary(input.activity),
    notify: notifyOnly([input.opponentId], notification),
  };
}

export function practiceRecordFeedback(
  input: PracticeRecordFeedbackInput,
): ChatUpdateMetadata | null {
  const score = assertCounter(input.score, "Practice score");
  const previous = assertCounter(input.previousChatRecord, "previous Practice record");
  if (score <= previous) return null;
  return {
    info: infoText(
      `${displayName(input.playerName)} set Practice record: ${exactNumber(score, "Practice score")}`,
    ),
    href: practiceLeaderboardHref(input.rulesHash),
    summary: tournamentSummary(input.activity),
  };
}
