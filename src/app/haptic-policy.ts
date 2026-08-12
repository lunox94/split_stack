import type { SimulationEffect } from "../domain/simulation";
import {
  type PresentationBoard,
} from "../render/presentation-timeline";
import { garbageSeatTimes, type GarbageSequencePlan } from "./garbage-sequence";

const GARBAGE_HAPTIC_MS = [18, 22, 26, 30] as const;

interface ScheduledPulse {
  readonly atMs: number;
  readonly durationMs: number;
}

export class GarbageHapticSequencer {
  readonly #pulses: ScheduledPulse[] = [];

  schedule(
    plan: GarbageSequencePlan,
    vibrationEnabled: boolean,
    protectedBoard: PresentationBoard,
    nowMs: number,
  ): number[] | null {
    if (!vibrationEnabled || protectedBoard !== "left") return null;
    this.#prune(nowMs);
    garbageSeatTimes(plan).forEach((atMs, index) => {
      this.#pulses.push({
        atMs,
        durationMs: GARBAGE_HAPTIC_MS[index] ??
          GARBAGE_HAPTIC_MS[GARBAGE_HAPTIC_MS.length - 1] ?? 30,
      });
    });
    this.#pulses.sort((left, right) => left.atMs - right.atMs);
    const windows = this.#pulses.reduce<Array<{ startMs: number; endMs: number }>>(
      (merged, pulse) => {
        const startMs = Math.max(nowMs, pulse.atMs);
        const endMs = pulse.atMs + pulse.durationMs;
        if (endMs <= startMs) return merged;
        const previous = merged[merged.length - 1];
        if (previous !== undefined && startMs <= previous.endMs) {
          previous.endMs = Math.max(previous.endMs, endMs);
        } else {
          merged.push({ startMs, endMs });
        }
        return merged;
      },
      [],
    );
    const pattern: number[] = [0, Math.max(0, windows[0]!.startMs - nowMs)];
    windows.forEach((window, index) => {
      pattern.push(window.endMs - window.startMs);
      const next = windows[index + 1];
      if (next !== undefined) pattern.push(next.startMs - window.endMs);
    });
    return pattern;
  }

  clear(): void {
    this.#pulses.length = 0;
  }

  #prune(nowMs: number): void {
    while (
      this.#pulses[0] !== undefined &&
      this.#pulses[0].atMs + this.#pulses[0].durationMs <= nowMs
    ) {
      this.#pulses.shift();
    }
  }
}

export function hapticDurationForSimulationEffect(
  effect: SimulationEffect,
  vibrationEnabled: boolean,
  protectedBoard: PresentationBoard,
): number | number[] | null {
  if (!vibrationEnabled || protectedBoard !== "left") return null;
  const rows = Math.max(0, effect.rows ?? 0);
  if (effect.kind === "barrier-block" && rows > 0) return 20;
  return null;
}
