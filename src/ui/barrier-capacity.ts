import { RULES } from "../config/rules";

export interface BarrierCapacityHud {
  readonly barrierCapacity: HTMLElement;
  readonly barrierCapacitySegments: readonly HTMLElement[];
}

export interface BarrierCapacityResolution {
  readonly activated: boolean;
  readonly blockedRows: number;
  readonly animate: boolean;
}

const STEP_MS = 55;
export const BARRIER_CAPACITY_TRANSITION_MS = 70;
const ACTIVATION_SETTLE_MS =
  (RULES.garbage.barrierCapacity - 1) * STEP_MS +
  BARRIER_CAPACITY_TRANSITION_MS;

interface PendingBarrierCapacity {
  targetCapacity: number;
  timeout: number;
}

const pendingCapacity = new WeakMap<HTMLElement, PendingBarrierCapacity>();

const clampCapacity = (value: number): number => Math.max(
  0,
  Math.min(RULES.garbage.barrierCapacity, Math.floor(value)),
);

const setAccessibleCapacity = (
  hud: BarrierCapacityHud,
  capacity: number,
): void => {
  const previous = Number(hud.barrierCapacity.dataset.capacity ?? "0");
  if (previous === capacity) return;
  hud.barrierCapacity.dataset.capacity = String(capacity);
  hud.barrierCapacity.setAttribute("aria-valuenow", String(capacity));
  hud.barrierCapacity.setAttribute(
    "aria-valuetext",
    `${capacity} of ${RULES.garbage.barrierCapacity} blocks remaining`,
  );
};

const applyVisualCapacity = (
  hud: BarrierCapacityHud,
  capacity: number,
  replayActivation = false,
): void => {
  const previous = Number(
    hud.barrierCapacity.dataset.visualCapacity ??
      hud.barrierCapacity.dataset.capacity ??
      "0",
  );
  if (previous === capacity && !replayActivation) return;
  hud.barrierCapacity.dataset.visualCapacity = String(capacity);
  if (capacity > previous || replayActivation) {
    hud.barrierCapacitySegments.forEach((segment, index) => {
      segment.classList.remove("is-filled");
      segment.style.setProperty("--barrier-step-delay", `${index * STEP_MS}ms`);
    });
    void hud.barrierCapacity.offsetWidth;
  }
  hud.barrierCapacitySegments.forEach((segment, index) => {
    const filled = index < capacity;
    let delay = 0;
    if (capacity > previous || replayActivation) {
      delay = index * STEP_MS;
    } else if (capacity < previous && index >= capacity && index < previous) {
      delay = (previous - 1 - index) * STEP_MS;
    }
    segment.style.setProperty("--barrier-step-delay", `${delay}ms`);
    segment.classList.toggle("is-filled", filled);
  });
};

export function setHudBarrierCapacity(
  hud: BarrierCapacityHud,
  value: number,
): void {
  const capacity = clampCapacity(value);
  setAccessibleCapacity(hud, capacity);
  const pending = pendingCapacity.get(hud.barrierCapacity);
  if (pending !== undefined) {
    pending.targetCapacity = capacity;
    return;
  }
  applyVisualCapacity(hud, capacity);
}

export function presentHudBarrierResolution(
  hud: BarrierCapacityHud,
  resolution: BarrierCapacityResolution,
): void {
  const window = hud.barrierCapacity.ownerDocument.defaultView;
  const previousPending = pendingCapacity.get(hud.barrierCapacity);
  const blockedRows = clampCapacity(resolution.blockedRows);
  if (!resolution.activated) {
    if (blockedRows === 0) return;
    const current = Number(hud.barrierCapacity.dataset.capacity ?? "0");
    const targetCapacity = clampCapacity(current - blockedRows);
    setAccessibleCapacity(hud, targetCapacity);
    if (previousPending !== undefined) {
      previousPending.targetCapacity = targetCapacity;
      return;
    }
    applyVisualCapacity(hud, targetCapacity);
    return;
  }

  if (previousPending !== undefined) {
    window?.clearTimeout(previousPending.timeout);
    pendingCapacity.delete(hud.barrierCapacity);
  }
  const targetCapacity = RULES.garbage.barrierCapacity - blockedRows;
  setAccessibleCapacity(hud, targetCapacity);
  if (!resolution.animate || window === null) {
    applyVisualCapacity(hud, targetCapacity);
    return;
  }
  applyVisualCapacity(hud, RULES.garbage.barrierCapacity, true);

  const pending: PendingBarrierCapacity = {
    targetCapacity,
    timeout: 0,
  };
  pending.timeout = window.setTimeout(() => {
    pendingCapacity.delete(hud.barrierCapacity);
    applyVisualCapacity(hud, pending.targetCapacity);
  }, ACTIVATION_SETTLE_MS);
  pendingCapacity.set(hud.barrierCapacity, pending);
}

export function resetHudBarrierCapacityPresentation(
  hud: BarrierCapacityHud,
): void {
  const window = hud.barrierCapacity.ownerDocument.defaultView;
  const pending = pendingCapacity.get(hud.barrierCapacity);
  if (pending !== undefined) {
    window?.clearTimeout(pending.timeout);
    pendingCapacity.delete(hud.barrierCapacity);
  }
  applyVisualCapacity(
    hud,
    clampCapacity(Number(hud.barrierCapacity.dataset.capacity ?? "0")),
  );
}
