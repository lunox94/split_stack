import { RULES } from "../config/rules";
import type { InputAction, InputSink } from "./actions";

const KEY_ACTIONS: Readonly<Record<string, InputAction>> = {
  arrowleft: "move-left",
  a: "move-left",
  arrowright: "move-right",
  d: "move-right",
  arrowup: "rotate-cw",
  x: "rotate-cw",
  e: "rotate-cw",
  z: "rotate-ccw",
  q: "rotate-ccw",
  arrowdown: "soft-drop",
  s: "soft-drop",
  " ": "hard-drop",
  spacebar: "hard-drop",
  c: "hold",
  shift: "hold",
};

export function keyboardActionForKey(key: string): InputAction | null {
  return KEY_ACTIONS[key.toLowerCase()] ?? null;
}

export class KeyboardInput {
  readonly #target: Window;
  readonly #sink: InputSink;
  readonly #pressedKeys = new Set<string>();
  readonly #blockedUntilRelease = new Set<string>();
  #enabled = true;
  #horizontalKey: string | null = null;
  #horizontalDelayTimer: number | null = null;
  #horizontalRepeatTimer: number | null = null;
  #softDropKey: string | null = null;
  #softDropTimer: number | null = null;

  constructor(target: Window, sink: InputSink) {
    this.#target = target;
    this.#sink = sink;
    target.addEventListener("keydown", this.#onKeyDown, { passive: false });
    target.addEventListener("keyup", this.#onKeyUp);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  releaseHorizontal(): void {
    this.#clearHorizontalRepeat();
    for (const key of this.#pressedKeys) {
      const action = keyboardActionForKey(key);
      if (action === "move-left" || action === "move-right") {
        this.#blockedUntilRelease.add(key);
      }
    }
  }

  releaseAll(): void {
    this.#clearHorizontalRepeat();
    this.#clearSoftDropRepeat();
    for (const key of this.#pressedKeys) this.#blockedUntilRelease.add(key);
  }

  dispose(): void {
    this.#target.removeEventListener("keydown", this.#onKeyDown);
    this.#target.removeEventListener("keyup", this.#onKeyUp);
    this.#pressedKeys.clear();
    this.#blockedUntilRelease.clear();
  }

  #emit(action: InputAction): void {
    this.#sink({ action, source: "keyboard" });
  }

  #startHorizontalRepeat(key: string, action: "move-left" | "move-right"): void {
    this.#clearHorizontalRepeat();
    this.#horizontalKey = key;
    this.#emit(action);
    this.#horizontalDelayTimer = this.#target.setTimeout(() => {
      this.#horizontalDelayTimer = null;
      if (
        !this.#enabled ||
        !this.#pressedKeys.has(key) ||
        this.#blockedUntilRelease.has(key)
      ) {
        return;
      }
      this.#emit(action);
      this.#horizontalRepeatTimer = this.#target.setInterval(() => {
        if (this.#enabled && this.#pressedKeys.has(key)) this.#emit(action);
      }, RULES.timing.arrMs);
    }, RULES.timing.dasMs);
  }

  #clearHorizontalRepeat(): void {
    if (this.#horizontalDelayTimer !== null) {
      this.#target.clearTimeout(this.#horizontalDelayTimer);
      this.#horizontalDelayTimer = null;
    }
    if (this.#horizontalRepeatTimer !== null) {
      this.#target.clearInterval(this.#horizontalRepeatTimer);
      this.#horizontalRepeatTimer = null;
    }
    this.#horizontalKey = null;
  }

  #startSoftDropRepeat(key: string): void {
    this.#clearSoftDropRepeat();
    this.#softDropKey = key;
    this.#emit("soft-drop");
    this.#softDropTimer = this.#target.setInterval(() => {
      if (this.#enabled && this.#pressedKeys.has(key)) this.#emit("soft-drop");
    }, RULES.timing.softDropRepeatMs);
  }

  #clearSoftDropRepeat(): void {
    if (this.#softDropTimer !== null) {
      this.#target.clearInterval(this.#softDropTimer);
      this.#softDropTimer = null;
    }
    this.#softDropKey = null;
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (!this.#enabled || event.altKey || event.ctrlKey || event.metaKey) return;
    const normalizedKey = event.key.toLowerCase();
    const action = keyboardActionForKey(event.key);
    if (action === null) return;
    event.preventDefault();
    if (this.#pressedKeys.has(normalizedKey)) return;
    this.#pressedKeys.add(normalizedKey);
    if (this.#blockedUntilRelease.has(normalizedKey)) return;
    if (action === "move-left" || action === "move-right") {
      this.#startHorizontalRepeat(normalizedKey, action);
      return;
    }
    if (action === "soft-drop") {
      this.#startSoftDropRepeat(normalizedKey);
      return;
    }
    this.#emit(action);
  };

  readonly #onKeyUp = (event: KeyboardEvent): void => {
    const normalizedKey = event.key.toLowerCase();
    this.#pressedKeys.delete(normalizedKey);
    this.#blockedUntilRelease.delete(normalizedKey);
    if (normalizedKey === this.#horizontalKey) {
      this.#clearHorizontalRepeat();
      const pressed = Array.from(this.#pressedKeys);
      let fallback: string | undefined;
      for (let index = pressed.length - 1; index >= 0; index -= 1) {
        const key = pressed[index] as string;
        const action = keyboardActionForKey(key);
        if (action === "move-left" || action === "move-right") {
          fallback = key;
          break;
        }
      }
      if (fallback !== undefined && !this.#blockedUntilRelease.has(fallback)) {
        const action = keyboardActionForKey(fallback);
        if (action === "move-left" || action === "move-right") {
          this.#startHorizontalRepeat(fallback, action);
        }
      }
    }
    if (normalizedKey === this.#softDropKey) this.#clearSoftDropRepeat();
  };
}
