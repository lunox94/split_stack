import type { AudioCue, CalloutCue } from "../audio/cues";
import type { ClearOrigin, SimulationEffect } from "../domain/simulation";
import type { LogicalAction, PowerKind } from "../domain/types";
import type { CompetitiveIncomingAttackKind } from "../match/competitive-session";

export interface LineClearAudioInput {
  readonly rows: number;
  readonly comboCount: number;
  readonly clearOrigin: ClearOrigin;
}

export interface LineClearAudioPlan {
  readonly sfx: AudioCue;
  readonly callout: CalloutCue | null;
  readonly calloutDelayMs: number;
}

export function audioPlanForLineClear(
  input: LineClearAudioInput,
): LineClearAudioPlan {
  const sfx: AudioCue = input.rows === 1
    ? "single"
    : input.rows === 2
      ? "double"
      : input.rows === 3
        ? "triple"
        : "four-line";
  let callout: CalloutCue | null = null;
  if (input.clearOrigin === "piece" && input.comboCount >= 2) {
    callout = input.comboCount === 2
      ? "combo-2"
      : input.comboCount === 3
        ? "combo-3"
        : input.comboCount === 4
          ? "combo-4"
          : "combo-5-plus";
  }
  return { sfx, callout, calloutDelayMs: 70 };
}

export function calloutForPower(power: PowerKind): CalloutCue {
  return `power-${power}` as CalloutCue;
}

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
  if (kind === "hollow-cross") return "hollow-cross";
  if (kind === "oversize") return "oversize-arrival";
  if (kind === "ghost-jam") return "ghost-jam-arrival";
  return null;
}

export function cueForPhysicalEffect(effect: SimulationEffect): AudioCue | null {
  if (effect.kind === "nuke" && effect.phase === "impact") return "nuke-impact";
  if (effect.kind === "collapse" && effect.phase === "drop") return "collapse-impact";
  if (effect.kind === "acid-dissolve" && effect.phase === "dissolve") {
    return "acid-consume";
  }
  return null;
}

export function panForPowerCue(power: PowerKind, sourceBoardPan: number): number {
  return power === "scramble" || power === "oversize" || power === "ghost-jam"
    ? -sourceBoardPan
    : sourceBoardPan;
}
