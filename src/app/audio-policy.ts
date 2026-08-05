import type { AudioCue } from "../audio/cues";
import type { LogicalAction, PowerKind } from "../domain/types";
import type { CompetitiveIncomingAttackKind } from "../match/competitive-session";

export function cueForAcceptedInput(
  action: LogicalAction,
  accepted: boolean,
): AudioCue | null {
  if (!accepted) return null;
  if (action === "move-left" || action === "move-right") return "move";
  if (action === "rotate-cw" || action === "rotate-ccw") return "rotate";
  if (action === "soft-drop") return "soft-drop";
  if (action === "hard-drop") return "hard-drop";
  return "hold";
}

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
