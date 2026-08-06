// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  actionsForGesture,
  classifyCompletedGesture,
  GestureInput,
  isGameplayGestureTarget,
} from "../../src/input/gestures";
import { KeyboardInput, keyboardActionForKey } from "../../src/input/keyboard";
import { transformScrambledAction } from "../../src/input/scramble-transform";
import { TouchButtonInput } from "../../src/input/touch-buttons";

function pointerEvent(
  type: "pointerdown" | "pointerup",
  pointerId: number,
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
  });
  return event as PointerEvent;
}

describe("Scramble input transformation", () => {
  it("swaps horizontal movement after an input has been recognized", () => {
    expect(transformScrambledAction("move-left", true)).toBe("move-right");
    expect(transformScrambledAction("move-right", true)).toBe("move-left");
  });

  it("swaps clockwise and counterclockwise rotation", () => {
    expect(transformScrambledAction("rotate-cw", true)).toBe("rotate-ccw");
    expect(transformScrambledAction("rotate-ccw", true)).toBe("rotate-cw");
  });

  it("leaves drop and Hold actions unchanged and is inert when inactive", () => {
    for (const action of ["soft-drop", "hard-drop", "hold"] as const) {
      expect(transformScrambledAction(action, true)).toBe(action);
    }
    expect(transformScrambledAction("move-left", false)).toBe("move-left");
    expect(transformScrambledAction("rotate-cw", false)).toBe("rotate-cw");
  });
});

describe("actionsForGesture", () => {
  it("maps one- and two-finger taps to opposite rotations", () => {
    expect(actionsForGesture({ kind: "tap", fingers: 1 })).toEqual([
      "rotate-cw",
    ]);
    expect(actionsForGesture({ kind: "tap", fingers: 2 })).toEqual([
      "rotate-ccw",
    ]);
  });

  it("emits one horizontal move for each crossed logical column", () => {
    expect(
      actionsForGesture({ kind: "horizontal-drag", crossedColumns: 3 }),
    ).toEqual(["move-right", "move-right", "move-right"]);
    expect(
      actionsForGesture({ kind: "horizontal-drag", crossedColumns: -2 }),
    ).toEqual(["move-left", "move-left"]);
  });

  it("maps downward hold, downward flick, and upward swipe", () => {
    expect(actionsForGesture({ kind: "downward-hold" })).toEqual([
      "soft-drop",
    ]);
    expect(actionsForGesture({ kind: "downward-flick" })).toEqual([
      "hard-drop",
    ]);
    expect(actionsForGesture({ kind: "upward-swipe" })).toEqual(["hold"]);
  });
});

describe("classifyCompletedGesture", () => {
  it("classifies a fast downward movement as a hard-drop flick", () => {
    expect(
      classifyCompletedGesture({
        deltaX: 2,
        deltaY: 60,
        durationMs: 50,
        cellSize: 20,
        maximumPointers: 1,
      }),
    ).toEqual({ kind: "downward-flick" });
  });

  it("distinguishes upward Hold swipes and taps by finger count", () => {
    expect(
      classifyCompletedGesture({
        deltaX: 1,
        deltaY: -30,
        durationMs: 180,
        cellSize: 20,
        maximumPointers: 1,
      }),
    ).toEqual({ kind: "upward-swipe" });
    expect(
      classifyCompletedGesture({
        deltaX: 1,
        deltaY: 2,
        durationMs: 120,
        cellSize: 20,
        maximumPointers: 2,
      }),
    ).toEqual({ kind: "tap", fingers: 2 });
  });
});

describe("isGameplayGestureTarget", () => {
  it("accepts either board and the surrounding arena but excludes explicit controls", () => {
    const arena = document.createElement("div");
    const remoteBoard = document.createElement("div");
    const hudText = document.createElement("span");
    const button = document.createElement("button");
    const nestedButtonIcon = document.createElement("span");
    button.append(nestedButtonIcon);
    arena.append(remoteBoard, hudText, button);

    expect(isGameplayGestureTarget(remoteBoard)).toBe(true);
    expect(isGameplayGestureTarget(hudText)).toBe(true);
    expect(isGameplayGestureTarget(button)).toBe(false);
    expect(isGameplayGestureTarget(nestedButtonIcon)).toBe(false);
  });
});

describe("GestureInput native touch suppression", () => {
  it("keeps the enabled native touch lifecycle inside the gameplay surface", () => {
    const root = document.createElement("div");
    const gameplaySurface = document.createElement("div");
    root.append(gameplaySurface);
    document.body.append(root);
    const input = new GestureInput(root, () => undefined, {
      getCellSize: () => 20,
    });

    for (const type of ["touchstart", "touchmove", "touchend"] as const) {
      const reachedTarget = vi.fn();
      gameplaySurface.addEventListener(type, reachedTarget);
      const event = new Event(type, {
        bubbles: true,
        cancelable: true,
      });

      gameplaySurface.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(reachedTarget).not.toHaveBeenCalled();
    }
    input.dispose();
    root.remove();
  });

  it("leaves explicit controls and gesture-blocked regions touchable", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const input = new GestureInput(root, () => undefined, {
      getCellSize: () => 20,
    });
    const blockedRegion = document.createElement("div");
    blockedRegion.setAttribute("data-gesture-blocked", "");
    const controls = [
      document.createElement("button"),
      document.createElement("input"),
      document.createElement("select"),
      document.createElement("a"),
      blockedRegion,
    ];
    root.append(...controls);

    for (const control of controls) {
      const reachedControl = vi.fn();
      control.addEventListener("touchstart", reachedControl);
      const event = new Event("touchstart", {
        bubbles: true,
        cancelable: true,
      });

      control.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(reachedControl).toHaveBeenCalledOnce();
    }
    input.dispose();
    root.remove();
  });

  it("stops suppressing native touch while disabled and after disposal", () => {
    const root = document.createElement("div");
    const gameplaySurface = document.createElement("div");
    root.append(gameplaySurface);
    document.body.append(root);
    const input = new GestureInput(root, () => undefined, {
      getCellSize: () => 20,
    });
    const reachedTarget = vi.fn();
    gameplaySurface.addEventListener("touchmove", reachedTarget);
    const dispatchTouchMove = (): Event => {
      const event = new Event("touchmove", {
        bubbles: true,
        cancelable: true,
      });
      gameplaySurface.dispatchEvent(event);
      return event;
    };

    input.setEnabled(false);
    expect(dispatchTouchMove().defaultPrevented).toBe(false);
    expect(reachedTarget).toHaveBeenCalledTimes(1);

    input.setEnabled(true);
    expect(dispatchTouchMove().defaultPrevented).toBe(true);
    expect(reachedTarget).toHaveBeenCalledTimes(1);

    input.dispose();
    expect(dispatchTouchMove().defaultPrevented).toBe(false);
    expect(reachedTarget).toHaveBeenCalledTimes(2);
    root.remove();
  });

  it("preserves pointer-driven gameplay actions", () => {
    const actions: string[] = [];
    const root = document.createElement("div");
    const gameplaySurface = document.createElement("div");
    root.append(gameplaySurface);
    document.body.append(root);
    const input = new GestureInput(
      root,
      ({ action }) => actions.push(action),
      { getCellSize: () => 20, now: () => 100 },
    );

    gameplaySurface.dispatchEvent(pointerEvent("pointerdown", 1));
    gameplaySurface.dispatchEvent(pointerEvent("pointerup", 1));

    expect(actions).toEqual(["rotate-cw"]);
    input.dispose();
    root.remove();
  });
});

describe("keyboardActionForKey", () => {
  it("recognizes both arrow and letter movement keys", () => {
    expect(keyboardActionForKey("ArrowLeft")).toBe("move-left");
    expect(keyboardActionForKey("a")).toBe("move-left");
    expect(keyboardActionForKey("ArrowRight")).toBe("move-right");
    expect(keyboardActionForKey("D")).toBe("move-right");
  });

  it("recognizes every clockwise and counterclockwise rotation key", () => {
    for (const key of ["ArrowUp", "x", "E"]) {
      expect(keyboardActionForKey(key)).toBe("rotate-cw");
    }
    for (const key of ["z", "Q"]) {
      expect(keyboardActionForKey(key)).toBe("rotate-ccw");
    }
  });

  it("recognizes drop and Hold controls and ignores unrelated keys", () => {
    expect(keyboardActionForKey("ArrowDown")).toBe("soft-drop");
    expect(keyboardActionForKey("s")).toBe("soft-drop");
    expect(keyboardActionForKey(" ")).toBe("hard-drop");
    expect(keyboardActionForKey("c")).toBe("hold");
    expect(keyboardActionForKey("Shift")).toBe("hold");
    expect(keyboardActionForKey("Escape")).toBeNull();
  });

  it("uses configured DAS/ARR and can release held horizontal input", () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const keyboard = new KeyboardInput(window, ({ action }) => actions.push(action));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(actions).toEqual(["move-left"]);
    vi.advanceTimersByTime(139);
    expect(actions).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(actions).toEqual(["move-left", "move-left"]);
    vi.advanceTimersByTime(35);
    expect(actions).toEqual(["move-left", "move-left", "move-left"]);

    keyboard.releaseHorizontal();
    vi.advanceTimersByTime(200);
    expect(actions).toHaveLength(3);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(actions).toHaveLength(4);

    keyboard.dispose();
    vi.useRealTimers();
  });

  it("leaves gameplay-key activation of an interactive control to the control", () => {
    const actions: string[] = [];
    const keyboard = new KeyboardInput(window, ({ action }) => actions.push(action));
    const button = document.createElement("button");
    const label = document.createElement("span");
    button.append(label);
    document.body.append(button);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
    });

    label.dispatchEvent(event);

    expect(actions).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    keyboard.dispose();
    button.remove();
  });

  it("keeps gameplay movement active after a touch button receives focus", () => {
    const actions: string[] = [];
    const keyboard = new KeyboardInput(window, ({ action }) => actions.push(action));
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();

    button.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
    }));
    button.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowLeft",
    }));

    expect(actions).toEqual(["move-left"]);
    keyboard.dispose();
    button.remove();
  });
});

describe("TouchButtonInput", () => {
  it("emits pointer and native keyboard activations exactly once", () => {
    const actions: string[] = [];
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.dataset.action = "hard-drop";
    root.append(button);
    const input = new TouchButtonInput(root, ({ action }) => actions.push(action));

    button.dispatchEvent(pointerEvent("pointerdown", 1));
    button.dispatchEvent(pointerEvent("pointerup", 1));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(actions).toEqual(["hard-drop"]);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(actions).toEqual(["hard-drop", "hard-drop"]);

    input.dispose();
  });

  it("owns one repeat pointer and stops repeats when disabled or hidden", () => {
    vi.useFakeTimers();
    const actions: string[] = [];
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.dataset.action = "move-left";
    root.append(button);
    const input = new TouchButtonInput(root, ({ action }) => actions.push(action));

    button.dispatchEvent(pointerEvent("pointerdown", 1));
    button.dispatchEvent(pointerEvent("pointerdown", 2));
    button.dispatchEvent(pointerEvent("pointerup", 2));
    expect(actions).toEqual(["move-left"]);
    vi.advanceTimersByTime(140 + 35);
    expect(actions).toEqual(["move-left", "move-left"]);

    input.setEnabled(false);
    expect(button.disabled).toBe(true);
    vi.advanceTimersByTime(500);
    button.dispatchEvent(pointerEvent("pointerdown", 3));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(actions).toHaveLength(2);

    input.setEnabled(true);
    button.dispatchEvent(pointerEvent("pointerdown", 3));
    expect(actions).toHaveLength(3);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(500);
    expect(actions).toHaveLength(3);

    visibility.mockRestore();
    input.dispose();
    vi.useRealTimers();
  });
});
