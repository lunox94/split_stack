import type { SimulationEffect } from "../domain/simulation";
import type { PresentationBoard } from "../render/presentation-timeline";

export function hapticDurationForSimulationEffect(
  effect: SimulationEffect,
  vibrationEnabled: boolean,
  protectedBoard: PresentationBoard,
): number | null {
  return vibrationEnabled &&
    protectedBoard === "left" &&
    effect.kind === "barrier-block" &&
    (effect.rows ?? 0) > 0
    ? 20
    : null;
}
