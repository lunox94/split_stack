import type { MatchResult } from "./types";

export function cloneMatchResult(result: MatchResult): MatchResult {
  const statsByPlayer: MatchResult["statsByPlayer"] = {};
  for (const [playerId, stats] of Object.entries(result.statsByPlayer)) {
    statsByPlayer[playerId] = { ...stats };
  }
  return {
    ...result,
    players: result.players.map((player) => ({ ...player })),
    statsByPlayer,
  };
}
