import { RULES } from "../config/rules";
import type { CompetitivePhase } from "../match/competitive-session";
import type {
  PieceDescriptor,
  PlayerLiveStats,
  PlayerResultStats,
} from "../domain/types";

export interface RandomValuesSource {
  getRandomValues(target: Uint8Array): Uint8Array;
}

export interface RuntimeRoster {
  matchId: string;
  role: "a" | "b" | "spectator";
  seatAOccupancyEventId: string;
  seatBOccupancyEventId: string;
  seatASessionId: string;
  seatBSessionId: string;
}

export interface DurableEventIdentity {
  eventId: string;
}

export type AppRuntimeMode =
  | "lobby"
  | "practice"
  | "competitive"
  | "spectator"
  | "results";

export function shouldGameplayMusicRun(
  mode: AppRuntimeMode,
  practicePaused: boolean,
  competitivePhase?: CompetitivePhase,
): boolean {
  if (mode === "competitive") {
    return competitivePhase === "countdown" || competitivePhase === "playing";
  }
  return mode === "spectator" || (mode === "practice" && !practicePaused);
}

export function shouldUseStaticMarkedCells(
  reducedMotion: boolean,
  reducedFlashes: boolean,
): boolean {
  return reducedMotion || reducedFlashes;
}

/** A runtime-scoped, non-identifying 128-bit token. */
export function createRuntimeId(random: RandomValuesSource = globalThis.crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A realtime binding is reusable only while both durable seat occupants agree. */
export function isSameRuntimeRoster(
  left: RuntimeRoster,
  right: RuntimeRoster,
): boolean {
  return (
    left.matchId === right.matchId &&
    left.role === right.role &&
    left.seatAOccupancyEventId === right.seatAOccupancyEventId &&
    left.seatBOccupancyEventId === right.seatBOccupancyEventId &&
    left.seatASessionId === right.seatASessionId &&
    left.seatBSessionId === right.seatBSessionId
  );
}

/** Returns only cosmetic preview state; concealed Glitches never expose their final shape. */
export function displayShapeAt(
  descriptor: PieceDescriptor,
  elapsedMs: number,
): PieceDescriptor["shape"] {
  const cosmetics = descriptor.previewCosmetics;
  if (
    cosmetics === undefined ||
    cosmetics.shapes.length === 0 ||
    !Number.isFinite(elapsedMs) ||
    cosmetics.intervalMs <= 0
  ) {
    return descriptor.shape;
  }
  const index = Math.floor(Math.max(0, elapsedMs) / cosmetics.intervalMs) % cosmetics.shapes.length;
  return cosmetics.shapes[index] ?? descriptor.shape;
}

/** Adds an untrusted durable event only once and never grows past the cap. */
export function appendBoundedUnique<T extends DurableEventIdentity>(
  target: T[],
  event: T,
  maximum: number,
): boolean {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    target.length >= maximum ||
    target.some((candidate) => candidate.eventId === event.eventId)
  ) {
    return false;
  }
  target.push(event);
  return true;
}

export function formatDuration(ticks: number): string {
  const totalSeconds = Math.max(
    0,
    Math.floor(ticks / RULES.timing.ticksPerSecond),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function resultStats(
  score: number,
  lines: number,
  stats: PlayerLiveStats,
): PlayerResultStats {
  return {
    score,
    lines,
    garbageSent: stats.garbageSent,
    powersActivated: stats.powersActivated,
    tetrises: stats.tetrises,
    tSpinSingles: stats.tSpinSingles,
    tSpinDoubles: stats.tSpinDoubles,
    tSpinTriples: stats.tSpinTriples,
    ...(stats.topOutTick === undefined ? {} : { topOutTick: stats.topOutTick }),
  };
}
