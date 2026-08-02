// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  actionsForGesture,
  classifyCompletedGesture,
} from "../../src/input/gestures";
import { KeyboardInput, keyboardActionForKey } from "../../src/input/keyboard";
import { transformScrambledAction } from "../../src/input/scramble-transform";

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
});
