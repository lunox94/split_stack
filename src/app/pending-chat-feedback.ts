import type { StoragePort } from "../persistence/settings";
import {
  isCompetitionEvent,
  type CompetitionEvent,
} from "./competition-ledger";
import type { ChatUpdateMetadata } from "./chat-feedback";

const STORAGE_SCHEMA = "split-stack/pending-chat-feedback/v2";
const STORAGE_KEY_PREFIX = `${STORAGE_SCHEMA}:`;
const MAX_PENDING_FEEDBACK = 64;
const TERMINAL_FEEDBACK_RESERVE = 2;
const MAX_STORED_CHARACTERS = 512_000;
const MAX_ID_CHARACTERS = 256;
const MAX_NAME_CHARACTERS = 128;
const MAX_HREF_CHARACTERS = 1_024;
const MAX_INFO_CHARACTERS = 50;
const MAX_SUMMARY_CHARACTERS = 20;

export type PendingChatFeedbackResolver =
  | { readonly kind: "challenge-created" }
  | { readonly kind: "challenge-cancelled" }
  | { readonly kind: "practice-record" }
  | {
      readonly kind: "challenge-joined";
      readonly creatorId: string;
    }
  | {
      readonly kind: "match-started";
      readonly seatAName: string;
      readonly seatBName: string;
    }
  | { readonly kind: "match-result" }
  | {
      readonly kind: "pairing-left";
      readonly source: "challenge" | "rematch";
      readonly seatALeft: boolean;
      readonly challengeId: string;
      readonly actorName: string;
    }
  | {
      readonly kind: "rematch-requested";
      readonly opponentId: string;
    };

export interface PendingChatFeedback {
  readonly schema: typeof STORAGE_SCHEMA;
  readonly payload: CompetitionEvent;
  readonly resolver: PendingChatFeedbackResolver;
  readonly resolved: boolean;
  readonly metadata?: ChatUpdateMetadata;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function resolverMatches(
  resolver: unknown,
  payload: CompetitionEvent,
): resolver is PendingChatFeedbackResolver {
  if (typeof resolver !== "object" || resolver === null || Array.isArray(resolver)) {
    return false;
  }
  const value = resolver as Record<string, unknown>;
  if (value.kind === "challenge-created") return payload.kind === "challenge-created";
  if (value.kind === "challenge-cancelled") return payload.kind === "challenge-cancelled";
  if (value.kind === "practice-record") return payload.kind === "practice-completed";
  if (value.kind === "challenge-joined") {
    return payload.kind === "challenge-claimed" &&
      isBoundedString(value.creatorId, MAX_ID_CHARACTERS);
  }
  if (value.kind === "match-started") {
    return payload.kind === "match-started" &&
      isBoundedString(value.seatAName, MAX_NAME_CHARACTERS) &&
      isBoundedString(value.seatBName, MAX_NAME_CHARACTERS);
  }
  if (value.kind === "match-result") {
    return payload.kind === "match-finished" || payload.kind === "match-conceded";
  }
  if (value.kind === "pairing-left") {
    return payload.kind === "pairing-left" &&
      (value.source === "challenge" || value.source === "rematch") &&
      typeof value.seatALeft === "boolean" &&
      isBoundedString(value.challengeId, MAX_ID_CHARACTERS) &&
      isBoundedString(value.actorName, MAX_NAME_CHARACTERS);
  }
  if (value.kind === "rematch-requested") {
    return payload.kind === "rematch-requested" &&
      isBoundedString(value.opponentId, MAX_ID_CHARACTERS);
  }
  return false;
}

function isMetadata(value: unknown): value is ChatUpdateMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  if (!isBoundedString(metadata.summary, MAX_SUMMARY_CHARACTERS)) return false;
  if (
    metadata.info !== undefined &&
    !isBoundedString(metadata.info, MAX_INFO_CHARACTERS)
  ) {
    return false;
  }
  if (
    metadata.href !== undefined &&
    !isBoundedString(metadata.href, MAX_HREF_CHARACTERS)
  ) {
    return false;
  }
  if (metadata.notify !== undefined) {
    if (
      typeof metadata.notify !== "object" ||
      metadata.notify === null ||
      Array.isArray(metadata.notify)
    ) {
      return false;
    }
    const notifications = Object.entries(metadata.notify);
    if (
      notifications.length > 4 ||
      notifications.some(([id, message]) =>
        !isBoundedString(id, MAX_ID_CHARACTERS) ||
        !isBoundedString(message, MAX_INFO_CHARACTERS)
      )
    ) {
      return false;
    }
  }
  return true;
}

function parseRecord(value: unknown, actorId: string): PendingChatFeedback | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== STORAGE_SCHEMA ||
    !isCompetitionEvent(record.payload) ||
    record.payload.actor.id !== actorId ||
    !resolverMatches(record.resolver, record.payload) ||
    typeof record.resolved !== "boolean"
  ) {
    return null;
  }
  if (record.resolved ? !isMetadata(record.metadata) : record.metadata !== undefined) {
    return null;
  }
  return record as unknown as PendingChatFeedback;
}

function cloneMetadata(metadata: ChatUpdateMetadata): ChatUpdateMetadata {
  return {
    summary: metadata.summary,
    ...(metadata.info === undefined ? {} : { info: metadata.info }),
    ...(metadata.href === undefined ? {} : { href: metadata.href }),
    ...(metadata.notify === undefined ? {} : { notify: { ...metadata.notify } }),
  };
}

/**
 * A small, player-scoped recovery journal. Entries survive until a replayed
 * metadata-bearing durable update proves that chat feedback was accepted.
 */
export class PendingChatFeedbackStore {
  private readonly entriesByEventId = new Map<string, PendingChatFeedback>();
  private readonly storageKey: string;

  public constructor(
    private readonly storage: StoragePort,
    rulesHash: string,
    private readonly actorId: string,
  ) {
    this.storageKey = `${STORAGE_KEY_PREFIX}${rulesHash}:${actorId}`;
    this.load();
  }

  public entries(): readonly PendingChatFeedback[] {
    return [...this.entriesByEventId.values()];
  }

  public get(eventId: string): PendingChatFeedback | undefined {
    return this.entriesByEventId.get(eventId);
  }

  public add(
    payload: CompetitionEvent,
    resolver: PendingChatFeedbackResolver,
  ): void {
    if (payload.actor.id !== this.actorId || !resolverMatches(resolver, payload)) return;
    if (!this.entriesByEventId.has(payload.eventId)) {
      if (resolver.kind !== "match-result") {
        if (this.entriesByEventId.size >= MAX_PENDING_FEEDBACK - TERMINAL_FEEDBACK_RESERVE) {
          return;
        }
      } else if (this.entriesByEventId.size >= MAX_PENDING_FEEDBACK) {
        const optionalEntry = [...this.entriesByEventId.entries()].find(
          ([, entry]) => entry.resolver.kind !== "match-result",
        );
        if (optionalEntry === undefined) return;
        this.entriesByEventId.delete(optionalEntry[0]);
      }
    }
    this.entriesByEventId.set(payload.eventId, {
      schema: STORAGE_SCHEMA,
      payload,
      resolver,
      resolved: false,
    });
    this.persist();
  }

  public resolve(eventId: string, metadata: ChatUpdateMetadata | null): void {
    const entry = this.entriesByEventId.get(eventId);
    if (entry === undefined) return;
    if (metadata === null) {
      this.entriesByEventId.delete(eventId);
    } else {
      this.entriesByEventId.set(eventId, {
        ...entry,
        resolved: true,
        metadata: cloneMetadata(metadata),
      });
    }
    this.persist();
  }

  public acknowledge(eventId: string): void {
    if (!this.entriesByEventId.delete(eventId)) return;
    this.persist();
  }

  private load(): void {
    let encoded: string | null = null;
    try {
      encoded = this.storage.getItem(this.storageKey);
    } catch {
      return;
    }
    if (encoded === null || encoded.length > MAX_STORED_CHARACTERS) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const candidate of parsed.slice(0, MAX_PENDING_FEEDBACK)) {
      const record = parseRecord(candidate, this.actorId);
      if (record !== null && !this.entriesByEventId.has(record.payload.eventId)) {
        this.entriesByEventId.set(record.payload.eventId, record);
      }
    }
  }

  private persist(): void {
    try {
      if (this.entriesByEventId.size === 0) {
        this.storage.setItem(this.storageKey, "[]");
      } else {
        this.storage.setItem(
          this.storageKey,
          JSON.stringify([...this.entriesByEventId.values()]),
        );
      }
    } catch {
      // Recovery is best effort when storage is unavailable or full.
    }
  }
}
