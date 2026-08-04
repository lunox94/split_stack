import { RULES } from "../config/rules";
import type { InputAction, InputSink } from "./actions";

export type GestureIntent =
  | {
      readonly kind: "tap";
      readonly fingers: 1 | 2;
    }
  | {
      readonly kind: "horizontal-drag";
      readonly crossedColumns: number;
    }
  | { readonly kind: "downward-hold" }
  | { readonly kind: "downward-flick" }
  | { readonly kind: "upward-swipe" };

export function actionsForGesture(intent: GestureIntent): readonly InputAction[] {
  if (intent.kind === "horizontal-drag") {
    const action = intent.crossedColumns < 0 ? "move-left" : "move-right";
    return Array.from({ length: Math.abs(Math.trunc(intent.crossedColumns)) }, () =>
      action,
    );
  }
  if (intent.kind === "downward-hold") return ["soft-drop"];
  if (intent.kind === "downward-flick") return ["hard-drop"];
  if (intent.kind === "upward-swipe") return ["hold"];
  return [intent.fingers === 2 ? "rotate-ccw" : "rotate-cw"];
}

export interface CompletedGesture {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly durationMs: number;
  readonly cellSize: number;
  readonly maximumPointers: number;
}

export function classifyCompletedGesture(
  gesture: CompletedGesture,
): GestureIntent | null {
  const cellSize = Math.max(1, gesture.cellSize);
  const durationMs = Math.max(1, gesture.durationMs);
  const downwardVelocity = (gesture.deltaY / durationMs) * 1_000;
  if (gesture.deltaY >= cellSize * 2 && downwardVelocity >= 900) {
    return { kind: "downward-flick" };
  }
  if (gesture.deltaY <= -cellSize * 1.25) {
    return { kind: "upward-swipe" };
  }
  const tapSlop = cellSize * 0.45;
  if (
    gesture.durationMs <= 260 &&
    Math.abs(gesture.deltaX) <= tapSlop &&
    Math.abs(gesture.deltaY) <= tapSlop
  ) {
    return { kind: "tap", fingers: gesture.maximumPointers >= 2 ? 2 : 1 };
  }
  return null;
}

interface PointerTrace {
  readonly startX: number;
  readonly startY: number;
  currentX: number;
  currentY: number;
}

export interface GestureInputOptions {
  readonly getCellSize: () => number;
  readonly now?: () => number;
  readonly shouldStart?: (event: PointerEvent) => boolean;
}

export function isGameplayGestureTarget(target: EventTarget | null): boolean {
  return !(target instanceof Element) ||
    target.closest("button, input, select, a, [data-gesture-blocked='true']") === null;
}

export class GestureInput {
  readonly #element: HTMLElement;
  readonly #sink: InputSink;
  readonly #getCellSize: () => number;
  readonly #now: () => number;
  readonly #shouldStart: (event: PointerEvent) => boolean;
  readonly #pointers = new Map<number, PointerTrace>();
  #enabled = true;
  #primaryPointerId: number | null = null;
  #startedAt = 0;
  #maximumPointers = 0;
  #lastHorizontalColumn = 0;
  #softDropTimer: number | null = null;
  #primaryCompletedTrace: PointerTrace | null = null;

  constructor(element: HTMLElement, sink: InputSink, options: GestureInputOptions) {
    this.#element = element;
    this.#sink = sink;
    this.#getCellSize = options.getCellSize;
    this.#now = options.now ?? (() => performance.now());
    this.#shouldStart = options.shouldStart ?? (() => true);
    element.addEventListener("pointerdown", this.#onPointerDown, {
      passive: false,
    });
    element.addEventListener("pointermove", this.#onPointerMove, {
      passive: false,
    });
    element.addEventListener("pointerup", this.#onPointerUp, { passive: false });
    element.addEventListener("pointercancel", this.#onPointerCancel);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.release();
  }

  release(): void {
    this.#stopSoftDrop();
    this.#pointers.clear();
    this.#primaryPointerId = null;
    this.#maximumPointers = 0;
    this.#lastHorizontalColumn = 0;
    this.#primaryCompletedTrace = null;
  }

  dispose(): void {
    this.release();
    this.#element.removeEventListener("pointerdown", this.#onPointerDown);
    this.#element.removeEventListener("pointermove", this.#onPointerMove);
    this.#element.removeEventListener("pointerup", this.#onPointerUp);
    this.#element.removeEventListener("pointercancel", this.#onPointerCancel);
  }

  #emit(intent: GestureIntent): void {
    for (const action of actionsForGesture(intent)) {
      this.#sink({ action, source: "gesture" });
    }
  }

  #startSoftDrop(): void {
    if (this.#softDropTimer !== null) return;
    this.#emit({ kind: "downward-hold" });
    const hostWindow = this.#element.ownerDocument.defaultView;
    if (hostWindow === null) return;
    this.#softDropTimer = hostWindow.setInterval(() => {
      if (this.#enabled) this.#emit({ kind: "downward-hold" });
    }, RULES.timing.softDropRepeatMs);
  }

  #stopSoftDrop(): void {
    if (this.#softDropTimer === null) return;
    const hostWindow = this.#element.ownerDocument.defaultView;
    if (hostWindow !== null) hostWindow.clearInterval(this.#softDropTimer);
    this.#softDropTimer = null;
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (!this.#enabled || !this.#shouldStart(event)) return;
    event.preventDefault();
    if (this.#pointers.size === 0) {
      this.#primaryPointerId = event.pointerId;
      this.#startedAt = this.#now();
      this.#maximumPointers = 0;
      this.#lastHorizontalColumn = 0;
      this.#primaryCompletedTrace = null;
    }
    this.#pointers.set(event.pointerId, {
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
    this.#maximumPointers = Math.max(this.#maximumPointers, this.#pointers.size);
    if (this.#maximumPointers > 1) this.#stopSoftDrop();
    try {
      this.#element.setPointerCapture(event.pointerId);
    } catch {
      // A detached element can reject capture; the document still dispatches up.
    }
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    const trace = this.#pointers.get(event.pointerId);
    if (!this.#enabled || trace === undefined) return;
    event.preventDefault();
    trace.currentX = event.clientX;
    trace.currentY = event.clientY;
    if (event.pointerId !== this.#primaryPointerId || this.#maximumPointers > 1) {
      return;
    }

    const cellSize = Math.max(1, this.#getCellSize());
    const deltaX = trace.currentX - trace.startX;
    const deltaY = trace.currentY - trace.startY;
    if (Math.abs(deltaX) >= Math.abs(deltaY)) {
      this.#stopSoftDrop();
      const logicalColumn = Math.trunc(deltaX / cellSize);
      const crossedColumns = logicalColumn - this.#lastHorizontalColumn;
      if (crossedColumns !== 0) {
        this.#emit({ kind: "horizontal-drag", crossedColumns });
        this.#lastHorizontalColumn = logicalColumn;
      }
      return;
    }

    if (deltaY >= cellSize * 0.75) this.#startSoftDrop();
    else this.#stopSoftDrop();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const trace = this.#pointers.get(event.pointerId);
    if (trace === undefined) return;
    event.preventDefault();
    trace.currentX = event.clientX;
    trace.currentY = event.clientY;
    const wasPrimary = event.pointerId === this.#primaryPointerId;
    if (wasPrimary) this.#primaryCompletedTrace = { ...trace };
    this.#pointers.delete(event.pointerId);
    if (this.#pointers.size > 0) return;

    this.#stopSoftDrop();
    const completedTrace = this.#primaryCompletedTrace ?? trace;
    const intent = classifyCompletedGesture({
      deltaX: completedTrace.currentX - completedTrace.startX,
      deltaY: completedTrace.currentY - completedTrace.startY,
      durationMs: this.#now() - this.#startedAt,
      cellSize: this.#getCellSize(),
      maximumPointers: this.#maximumPointers,
    });
    if (intent !== null) this.#emit(intent);
    this.release();
  };

  readonly #onPointerCancel = (): void => {
    this.release();
  };
}
