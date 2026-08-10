import { RULES } from "../config/rules";
import type { SimulationEffect } from "../domain/simulation";
import type { CompetitiveIncomingAttackKind } from "../match/competitive-session";
import type {
  OffensiveAttack,
  GridPoint,
  PresentationBoard,
  PresentationCue,
} from "../render/presentation-timeline";

export interface PresentationScheduler {
  schedule(cue: PresentationCue, startedAtMs: number): unknown;
}

export type GhostCellsProvider = (
  board: PresentationBoard,
) => readonly GridPoint[];

const otherBoard = (board: PresentationBoard): PresentationBoard =>
  board === "left" ? "right" : "left";

const outgoingAttackFor = (
  effect: SimulationEffect,
): OffensiveAttack | null => {
  if (effect.kind === "garbage-attack") return "garbage";
  if (effect.kind === "hollow-cross") return "hollow-cross";
  if (effect.kind === "glitch-piece") return "glitch";
  return null;
};

export class PresentationRouter {
  readonly #scheduler: PresentationScheduler;
  readonly #now: () => number;
  readonly #ghostCellsFor: GhostCellsProvider;
  #ordinal = 0;

  constructor(
    scheduler: PresentationScheduler,
    now: () => number = () => performance.now(),
    ghostCellsFor: GhostCellsProvider = () => [],
  ) {
    this.#scheduler = scheduler;
    this.#now = now;
    this.#ghostCellsFor = ghostCellsFor;
  }

  consumeSimulationEffects(
    effects: readonly SimulationEffect[],
    board: PresentationBoard,
  ): void {
    for (const effect of effects) {
      if (effect.kind === "special-trigger") continue;
      const id = effect.eventId ?? this.#nextId(effect.kind);
      if (effect.kind === "line-clear" && effect.phase === "anticipation") {
        const rows = [...new Set((effect.cells ?? []).map((cell) => cell.y))];
        if (rows.length > 0) {
          this.#schedule({ id, kind: "line-clear", board, rows });
        }
        continue;
      }
      if (effect.kind === "garbage-rise") {
        this.#schedule({
          id,
          kind: "garbage-rise",
          board,
          rowCount: Math.max(1, effect.rows ?? 1),
        });
        continue;
      }
      if (effect.kind === "barrier-block") {
        this.#schedule({ id, kind: "barrier-hit", board });
        continue;
      }
      const outgoingAttack = outgoingAttackFor(effect);
      if (outgoingAttack !== null) {
        this.#schedule({
          id,
          kind: "offensive-transfer",
          attack: outgoingAttack,
          source: board,
          target: otherBoard(board),
        });
        continue;
      }
      if (effect.kind === "power-activated") {
        if (effect.power === "nuke" && effect.target !== undefined) {
          this.#schedule({
            id,
            kind: "nuke",
            board,
            center: { column: effect.target.x, row: effect.target.y },
          });
        } else if (
          effect.power === "scramble" ||
          effect.power === "oversize" ||
          effect.power === "ghost-jam"
        ) {
          this.#schedule({
            id,
            kind: "offensive-transfer",
            attack: effect.power,
            source: board,
            target: otherBoard(board),
          });
        } else if (effect.power === "monomino-rush") {
          this.#schedule({ id, kind: "monomino-rush", board });
        } else if (effect.power === "collapse") {
          this.#schedule({
            id,
            kind: "collapse",
            board,
            completedRows: [],
            movements: [],
          });
        }
        continue;
      }
      if (effect.kind === "blackout-start") {
        this.#schedule({
          id,
          kind: "offensive-transfer",
          attack: "blackout",
          source: board,
          target: otherBoard(board),
        });
        continue;
      }
      if (effect.kind === "ghost-jam-start") {
        const target = otherBoard(board);
        this.#schedule({
          id: `${id}:ghost-jam`,
          kind: "ghost-jam",
          board: target,
          ghostCells: this.#ghostCellsFor(target).map((cell) => ({ ...cell })),
        });
        continue;
      }
      if (effect.kind === "barrier-start") {
        this.#schedule({
          id,
          kind: "barrier",
          board,
          capacity: RULES.garbage.barrierCapacity,
        });
        continue;
      }
      if (effect.kind === "acid-lock" && effect.column !== undefined) {
        this.#schedule({
          id,
          kind: "acid-dissolve",
          board,
          column: effect.column,
          occupiedRows: (effect.cells ?? []).map((cell) => cell.y),
        });
        continue;
      }
      if (effect.kind === "collapse" && effect.phase === "drop") {
        this.#schedule({
          id,
          kind: "collapse",
          board,
          completedRows: [],
          movements: (effect.movements ?? []).map((movement) => ({
            from: { ...movement.from },
            to: { ...movement.to },
          })),
        });
      }
    }

    const triggers = effects.flatMap((effect) =>
      effect.kind === "special-trigger" &&
      effect.special !== undefined &&
      effect.row !== undefined &&
      effect.column !== undefined
        ? [{ special: effect.special, row: effect.row, column: effect.column }]
        : [],
    );
    if (triggers.length > 0) {
      this.#schedule({
        id: this.#nextId("special-chain"),
        kind: "special-chain",
        board,
        triggers,
      });
    }
  }

  consumeIncomingAttack(
    kind: CompetitiveIncomingAttackKind,
    eventId: string,
    _value?: number,
  ): void {
    if (kind === "scramble") {
      this.#schedule({ id: eventId, kind: "scramble", board: "left" });
      return;
    }
    if (kind === "blackout") {
      this.#schedule({ id: eventId, kind: "blackout", board: "right" });
      return;
    }
    if (kind === "ghost-jam") {
      this.#schedule({
        id: eventId,
        kind: "ghost-jam",
        board: "left",
        ghostCells: this.#ghostCellsFor("left").map((cell) => ({ ...cell })),
      });
      return;
    }
    this.#schedule({
      id: eventId,
      kind: "offensive-transfer",
      attack: kind,
      source: "right",
      target: "left",
    });
  }

  #schedule(cue: PresentationCue): void {
    this.#scheduler.schedule(cue, this.#now());
  }

  #nextId(purpose: string): string {
    this.#ordinal += 1;
    return `presentation:${this.#ordinal}:${purpose}`;
  }
}
