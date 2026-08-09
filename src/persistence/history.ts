import { cloneMatchResult } from "../domain/results";
import type { MatchResult } from "../domain/types";

export interface DurableResultRecord {
  serial: number;
  payload: unknown;
}

export interface MaterializedResult {
  result: MatchResult;
  serial: number;
  conflicted: boolean;
  variantCount: number;
}

export interface PairTally {
  playerIds: [string, string];
  winsByPlayer: Record<string, number>;
}

export interface HistoryView {
  latest: MaterializedResult[];
  tallies: PairTally[];
}

interface ResultEntry {
  variants: Map<string, MatchResult>;
  firstSerial: number;
}

/** Security bounds for untrusted durable logs; comfortably above normal chat use. */
export const HISTORY_MAX_MATCHES = 10_000;
export const HISTORY_MAX_VARIANTS_PER_MATCH = 2;

export interface HistoryDiagnostics {
  matchCount: number;
  maximumVariantCount: number;
  capacityReached: boolean;
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPlayerResultStats(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const stats = value as Record<string, unknown>;
  const required = [
    "score",
    "lines",
    "garbageSent",
    "powersActivated",
    "tetrises",
    "tSpinSingles",
    "tSpinDoubles",
    "tSpinTriples",
  ];
  if (!required.every((field) => isNonNegativeInteger(stats[field]))) return false;
  return stats.topOutTick === undefined || isNonNegativeInteger(stats.topOutTick);
}

function isResultPlayer(value: unknown): value is MatchResult["players"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const player = value as Record<string, unknown>;
  return (
    typeof player.id === "string" &&
    player.id.length > 0 &&
    player.id.length <= 256 &&
    typeof player.displayName === "string" &&
    player.displayName.length <= 128
  );
}

export function isMatchResult(value: unknown): value is MatchResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Partial<MatchResult>;
  if (
    result.schema !== "split-stack/result/v1" ||
    typeof result.matchId !== "string" ||
    result.matchId.length === 0 ||
    result.matchId.length > 256 ||
    typeof result.seedHash !== "string" ||
    result.seedHash.length > 256 ||
    !Array.isArray(result.players) ||
    result.players.length !== 2 ||
    !result.players.every(isResultPlayer) ||
    result.players[0]?.id === result.players[1]?.id ||
    !["seat-a", "seat-b", "draw", "desync"].includes(String(result.outcome)) ||
    ![
      "top-out",
      "forfeit",
      "simultaneous",
      "desynchronization",
      "connection-lost",
    ].includes(
      String(result.reason),
    ) ||
    !isNonNegativeInteger(result.durationTicks) ||
    !isNonNegativeInteger(result.finalLevel) ||
    result.finalLevel < 1 ||
    typeof result.statsByPlayer !== "object" ||
    result.statsByPlayer === null ||
    typeof result.completedBy !== "string" ||
    result.completedBy.length === 0 ||
    result.completedBy.length > 256
  ) {
    return false;
  }
  const playerIds = result.players.map((player) => player.id);
  const statsRecord = result.statsByPlayer as Record<string, unknown>;
  if (
    Object.keys(statsRecord).length !== 2 ||
    !playerIds.every((playerId) => isPlayerResultStats(statsRecord[playerId])) ||
    !playerIds.includes(result.completedBy)
  ) {
    return false;
  }
  if (result.outcome === "draw") return result.reason === "simultaneous";
  if (result.outcome === "desync") {
    return result.reason === "desynchronization" || result.reason === "connection-lost";
  }
  return result.reason === "top-out" || result.reason === "forfeit";
}

function pairKey(first: string, second: string): string {
  return `${first.length}:${first}${second.length}:${second}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function conflictResult(variants: readonly MatchResult[]): MatchResult {
  const base = [...variants].sort((left, right) =>
    compareCodeUnits(stableJson(left), stableJson(right)),
  )[0];
  if (base === undefined) throw new Error("Cannot materialize an empty result conflict");
  const connectionLost = variants.every(
    (variant) =>
      variant.outcome === "desync" && variant.reason === "connection-lost",
  );
  return {
    ...base,
    outcome: "desync",
    reason: connectionLost ? "connection-lost" : "desynchronization",
  };
}

function materializeEntry(entry: ResultEntry): MaterializedResult | undefined {
  const variants = [...entry.variants.values()];
  const conflicted = variants.length > 1;
  const result = conflicted ? conflictResult(variants) : variants[0];
  if (result === undefined) return undefined;
  return {
    result: cloneMatchResult(result),
    serial: entry.firstSerial,
    conflicted,
    variantCount: variants.length,
  };
}

export class HistoryMaterializer {
  private readonly entries = new Map<string, ResultEntry>();
  private reachedCapacity = false;

  public apply(record: DurableResultRecord): boolean {
    if (!Number.isSafeInteger(record.serial) || record.serial < 1 || !isMatchResult(record.payload)) {
      return false;
    }
    const accepted = cloneMatchResult(record.payload);
    const fingerprint = stableJson(accepted);
    let entry = this.entries.get(accepted.matchId);
    if (entry === undefined) {
      if (this.entries.size >= HISTORY_MAX_MATCHES) {
        this.reachedCapacity = true;
        return false;
      }
      entry = { variants: new Map(), firstSerial: record.serial };
      this.entries.set(accepted.matchId, entry);
    }
    if (
      entry.variants.has(fingerprint) ||
      entry.variants.size < HISTORY_MAX_VARIANTS_PER_MATCH
    ) {
      entry.variants.set(fingerprint, accepted);
    } else {
      this.reachedCapacity = true;
    }
    entry.firstSerial = Math.min(entry.firstSerial, record.serial);
    return true;
  }

  public diagnostics(): HistoryDiagnostics {
    let maximumVariantCount = 0;
    for (const entry of this.entries.values()) {
      maximumVariantCount = Math.max(maximumVariantCount, entry.variants.size);
    }
    return {
      matchCount: this.entries.size,
      maximumVariantCount,
      capacityReached: this.reachedCapacity,
    };
  }

  public findByMatchId(matchId: string): MaterializedResult | undefined {
    const entry = this.entries.get(matchId);
    return entry === undefined ? undefined : materializeEntry(entry);
  }

  public view(): HistoryView {
    const materialized: MaterializedResult[] = [];
    const tallies = new Map<string, PairTally>();

    for (const entry of this.entries.values()) {
      const item = materializeEntry(entry);
      if (item === undefined) continue;
      materialized.push(item);
      const { conflicted, result } = item;
      if (conflicted || result.outcome === "draw" || result.outcome === "desync") continue;

      const seatA = result.players[0];
      const seatB = result.players[1];
      if (seatA === undefined || seatB === undefined) continue;
      const [first, second] = [seatA.id, seatB.id].sort() as [string, string];
      const key = pairKey(first, second);
      let tally = tallies.get(key);
      if (tally === undefined) {
        tally = {
          playerIds: [first, second],
          winsByPlayer: { [first]: 0, [second]: 0 },
        };
        tallies.set(key, tally);
      }
      const winner = result.outcome === "seat-a" ? seatA.id : seatB.id;
      tally.winsByPlayer[winner] = (tally.winsByPlayer[winner] ?? 0) + 1;
    }

    materialized.sort(
      (left, right) =>
        right.serial - left.serial || compareCodeUnits(left.result.matchId, right.result.matchId),
    );
    return {
      latest: materialized.slice(0, 20),
      tallies: [...tallies.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([, tally]) => tally),
    };
  }
}
