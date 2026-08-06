// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  presentHudBarrierResolution,
  resetHudBarrierCapacityPresentation,
  setHudBarrierCapacity,
} from "../../src/ui/barrier-capacity";
import { createAppShell } from "../../src/ui/shell";

const filledCount = (segments: readonly HTMLElement[]): number =>
  segments.filter((segment) => segment.classList.contains("is-filled")).length;

describe("Barrier capacity presentation", () => {
  it("finishes a four-slot activation before showing same-resolution consumption", () => {
    vi.useFakeTimers();
    try {
      const shell = createAppShell(document, document.createElement("div"));

      presentHudBarrierResolution(shell.left, {
        activated: true,
        blockedRows: 3,
        animate: true,
      });
      setHudBarrierCapacity(shell.left, 1);

      expect(shell.left.barrierCapacity.dataset.capacity).toBe("1");
      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("4");
      expect(shell.left.barrierCapacity.getAttribute("aria-valuenow")).toBe("1");
      expect(filledCount(shell.left.barrierCapacitySegments)).toBe(4);
      expect(
        shell.left.barrierCapacitySegments.map((segment) =>
          segment.style.getPropertyValue("--barrier-step-delay")
        ),
      ).toEqual(["0ms", "55ms", "110ms", "165ms"]);

      vi.advanceTimersByTime(234);
      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("4");
      vi.advanceTimersByTime(1);

      expect(shell.left.barrierCapacity.dataset.capacity).toBe("1");
      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("1");
      expect(filledCount(shell.left.barrierCapacitySegments)).toBe(1);
      expect(
        shell.left.barrierCapacitySegments.map((segment) =>
          segment.style.getPropertyValue("--barrier-step-delay")
        ),
      ).toEqual(["0ms", "110ms", "55ms", "0ms"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates activation and consumption immediately without animation", () => {
    const shell = createAppShell(document, document.createElement("div"));

    presentHudBarrierResolution(shell.left, {
      activated: true,
      blockedRows: 3,
      animate: false,
    });

    expect(shell.left.barrierCapacity.dataset.capacity).toBe("1");
    expect(filledCount(shell.left.barrierCapacitySegments)).toBe(1);
  });

  it("does not rewrite a full Barrier when animation is disabled", () => {
    const shell = createAppShell(document, document.createElement("div"));
    setHudBarrierCapacity(shell.left, 4);
    const remove = vi.spyOn(
      shell.left.barrierCapacitySegments[0]!.classList,
      "remove",
    );
    const toggle = vi.spyOn(
      shell.left.barrierCapacitySegments[0]!.classList,
      "toggle",
    );

    presentHudBarrierResolution(shell.left, {
      activated: true,
      blockedRows: 0,
      animate: false,
    });

    expect(remove).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("replays the left-to-right activation when a full Barrier is refreshed", () => {
    vi.useFakeTimers();
    try {
      const shell = createAppShell(document, document.createElement("div"));
      setHudBarrierCapacity(shell.left, 4);
      shell.left.barrierCapacitySegments.forEach((segment) => {
        segment.style.setProperty("--barrier-step-delay", "0ms");
      });

      presentHudBarrierResolution(shell.left, {
        activated: true,
        blockedRows: 0,
        animate: true,
      });

      expect(shell.left.barrierCapacity.dataset.capacity).toBe("4");
      expect(filledCount(shell.left.barrierCapacitySegments)).toBe(4);
      expect(
        shell.left.barrierCapacitySegments.map((segment) =>
          segment.style.getPropertyValue("--barrier-step-delay")
        ),
      ).toEqual(["0ms", "55ms", "110ms", "165ms"]);
      vi.advanceTimersByTime(235);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues a later block until the activation cascade settles", () => {
    vi.useFakeTimers();
    try {
      const shell = createAppShell(document, document.createElement("div"));
      presentHudBarrierResolution(shell.left, {
        activated: true,
        blockedRows: 0,
        animate: true,
      });
      setHudBarrierCapacity(shell.left, 4);

      vi.advanceTimersByTime(200);
      presentHudBarrierResolution(shell.left, {
        activated: false,
        blockedRows: 3,
        animate: true,
      });
      setHudBarrierCapacity(shell.left, 1);

      expect(shell.left.barrierCapacity.dataset.capacity).toBe("1");
      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("4");
      vi.advanceTimersByTime(34);
      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("4");
      vi.advanceTimersByTime(1);
      expect(shell.left.barrierCapacity.dataset.capacity).toBe("1");
      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("1");
      expect(filledCount(shell.left.barrierCapacitySegments)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the prior capacity for an event-driven block", () => {
    const shell = createAppShell(document, document.createElement("div"));
    setHudBarrierCapacity(shell.left, 4);

    presentHudBarrierResolution(shell.left, {
      activated: false,
      blockedRows: 2,
      animate: true,
    });

    expect(shell.left.barrierCapacity.dataset.capacity).toBe("2");
    expect(filledCount(shell.left.barrierCapacitySegments)).toBe(2);
    expect(
      shell.left.barrierCapacitySegments.map((segment) =>
        segment.style.getPropertyValue("--barrier-step-delay")
      ),
    ).toEqual(["0ms", "0ms", "55ms", "0ms"]);
  });

  it("flushes and cancels a pending activation when presentation resets", () => {
    vi.useFakeTimers();
    try {
      const shell = createAppShell(document, document.createElement("div"));
      presentHudBarrierResolution(shell.left, {
        activated: true,
        blockedRows: 3,
        animate: true,
      });

      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("4");
      resetHudBarrierCapacityPresentation(shell.left);

      expect(shell.left.barrierCapacity.dataset.capacity).toBe("1");
      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("1");
      expect(filledCount(shell.left.barrierCapacitySegments)).toBe(1);
      vi.advanceTimersByTime(500);
      expect(shell.left.barrierCapacity.dataset.visualCapacity).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });
});
