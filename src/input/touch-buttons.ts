import { RULES } from "../config/rules";
import type { LogicalAction } from "../domain/types";
import { ALL_INPUT_ACTIONS, type InputSink } from "./actions";

interface BoundTouchControl {
  readonly element: HTMLButtonElement;
  release(): void;
  dispose(): void;
}

function logicalAction(value: string | undefined): LogicalAction | null {
  return ALL_INPUT_ACTIONS.find((action) => action === value) ?? null;
}

/**
 * Owns the compact touch-button activation and repeat lifecycle. Pointer input
 * acts on pointerdown for low latency; native keyboard activation arrives as a
 * detail-0 click and is emitted exactly once.
 */
export class TouchButtonInput {
  readonly #document: Document;
  readonly #controls: BoundTouchControl[];
  readonly #sink: InputSink;
  #enabled = true;

  constructor(root: HTMLElement, sink: InputSink) {
    this.#document = root.ownerDocument;
    this.#sink = sink;
    this.#controls = Array.from(
      root.querySelectorAll<HTMLButtonElement>("button[data-action]"),
    ).flatMap((element) => {
      const action = logicalAction(element.dataset.action);
      return action === null ? [] : [this.#bind(element, action)];
    });
    this.#document.addEventListener("visibilitychange", this.#onVisibilityChange);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    for (const control of this.#controls) control.element.disabled = !enabled;
    if (!enabled) this.releaseAll();
  }

  releaseAll(): void {
    for (const control of this.#controls) control.release();
  }

  dispose(): void {
    this.#document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    for (const control of this.#controls) control.dispose();
  }

  readonly #onVisibilityChange = (): void => {
    if (this.#document.visibilityState === "hidden") this.releaseAll();
  };

  #emit(action: LogicalAction): void {
    if (this.#enabled) this.#sink({ action, source: "button" });
  }

  #bind(element: HTMLButtonElement, action: LogicalAction): BoundTouchControl {
    const hostWindow = element.ownerDocument.defaultView;
    let activePointerId: number | null = null;
    let repeatTimer: number | null = null;
    let delayTimer: number | null = null;

    const release = (): void => {
      if (hostWindow !== null) {
        if (repeatTimer !== null) hostWindow.clearInterval(repeatTimer);
        if (delayTimer !== null) hostWindow.clearTimeout(delayTimer);
      }
      repeatTimer = null;
      delayTimer = null;
      activePointerId = null;
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (
        !this.#enabled ||
        activePointerId !== null ||
        (event.pointerType === "mouse" && event.button !== 0)
      ) return;
      event.preventDefault();
      release();
      activePointerId = event.pointerId;
      this.#emit(action);
      if (
        hostWindow === null ||
        (action !== "move-left" && action !== "move-right" && action !== "soft-drop")
      ) return;
      const pointerId = event.pointerId;
      const delay = action === "soft-drop"
        ? RULES.timing.softDropRepeatMs
        : RULES.timing.dasMs;
      delayTimer = hostWindow.setTimeout(() => {
        delayTimer = null;
        if (!this.#enabled || activePointerId !== pointerId) return;
        repeatTimer = hostWindow.setInterval(() => {
          if (this.#enabled && activePointerId === pointerId) this.#emit(action);
        }, RULES.timing.arrMs);
      }, delay);
    };
    const onClick = (event: MouseEvent): void => {
      event.preventDefault();
      if (this.#enabled && event.detail === 0) this.#emit(action);
    };
    const onPointerFinished = (event: PointerEvent): void => {
      if (event.pointerId === activePointerId) release();
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("click", onClick);
    element.addEventListener("pointerup", onPointerFinished);
    element.addEventListener("pointercancel", onPointerFinished);
    element.addEventListener("pointerleave", onPointerFinished);

    return {
      element,
      release,
      dispose: () => {
        release();
        element.removeEventListener("pointerdown", onPointerDown);
        element.removeEventListener("click", onClick);
        element.removeEventListener("pointerup", onPointerFinished);
        element.removeEventListener("pointercancel", onPointerFinished);
        element.removeEventListener("pointerleave", onPointerFinished);
      },
    };
  }
}
