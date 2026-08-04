import type { AudioCue } from "../audio/cues";
import type { PowerKind } from "../domain/types";
import type { CompetitiveIncomingAttackKind } from "../match/competitive-session";

export function cueForIncomingAttack(
  kind: CompetitiveIncomingAttackKind,
): AudioCue | null {
  if (kind === "oversize") return "power-oversize";
  if (kind === "ghost-jam") return "power-ghost-jam";
  return null;
}

export function panForPowerCue(power: PowerKind, sourceBoardPan: number): number {
  return power === "scramble" || power === "oversize" || power === "ghost-jam"
    ? -sourceBoardPan
    : sourceBoardPan;
}
