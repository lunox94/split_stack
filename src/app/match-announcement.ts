import { RULES } from "../config/rules";
import { hashCanonicalHex } from "../domain/hashing";
import type { MatchResultV1 } from "../domain/types";
import {
  MAX_DURABLE_LOGICAL_CLOCK,
  type LobbyActor,
} from "../network/webxdc-durable";

export interface MatchAnnouncementV1 {
  schema: "split-stack/match-announcement/v1";
  eventId: string;
  logicalClock: number;
  challengeId: string;
  matchId: string;
  round: number;
  rulesHash: string;
  configHash: string;
  seed: string;
  seedHash: string;
  seatAPlayerId: string;
  seatBPlayerId: string;
  actor: LobbyActor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function expectedConfigHash(announcement: MatchAnnouncementV1): string {
  return hashCanonicalHex({
    rulesVersion: RULES.rulesVersion,
    rulesHash: announcement.rulesHash,
    seed: announcement.seed,
    seatAPlayerId: announcement.seatAPlayerId,
    seatBPlayerId: announcement.seatBPlayerId,
  });
}

export function isMatchAnnouncementV1(
  value: unknown,
  expectedRulesHash: string,
): value is MatchAnnouncementV1 {
  if (!isRecord(value) || !isRecord(value.actor)) return false;
  const candidate = value as unknown as MatchAnnouncementV1;
  return (
    candidate.schema === "split-stack/match-announcement/v1" &&
    isBoundedString(candidate.eventId) &&
    Number.isSafeInteger(candidate.logicalClock) &&
    candidate.logicalClock > 0 &&
    candidate.logicalClock <= MAX_DURABLE_LOGICAL_CLOCK &&
    isBoundedString(candidate.challengeId) &&
    Number.isSafeInteger(candidate.round) &&
    candidate.round > 0 &&
    candidate.round < 10_000 &&
    candidate.matchId === `${candidate.challengeId}:round:${candidate.round}` &&
    candidate.rulesHash === expectedRulesHash &&
    isBoundedString(candidate.configHash) &&
    typeof candidate.seed === "string" &&
    /^[0-9a-f]{32}$/i.test(candidate.seed) &&
    candidate.seedHash === hashCanonicalHex({ seed: candidate.seed }) &&
    isBoundedString(candidate.seatAPlayerId) &&
    isBoundedString(candidate.seatBPlayerId) &&
    candidate.seatAPlayerId !== candidate.seatBPlayerId &&
    candidate.actor.id === candidate.seatAPlayerId &&
    isBoundedString(candidate.actor.displayName, 128) &&
    candidate.configHash === expectedConfigHash(candidate)
  );
}

export function resultMatchesAnnouncement(
  result: MatchResultV1,
  announcement: MatchAnnouncementV1,
): boolean {
  return (
    result.matchId === announcement.matchId &&
    result.seedHash === announcement.seedHash &&
    result.players[0]?.id === announcement.seatAPlayerId &&
    result.players[1]?.id === announcement.seatBPlayerId &&
    (result.completedBy === announcement.seatAPlayerId ||
      result.completedBy === announcement.seatBPlayerId)
  );
}
