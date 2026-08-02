import type { MatchResultV1 } from "./types";

export function cloneMatchResult(result: MatchResultV1): MatchResultV1 {
  const statsByPlayer: MatchResultV1["statsByPlayer"] = {};
  for (const [playerId, stats] of Object.entries(result.statsByPlayer)) {
    statsByPlayer[playerId] = { ...stats };
  }
  return {
    ...result,
    players: result.players.map((player) => ({ ...player })),
    statsByPlayer,
  };
}
