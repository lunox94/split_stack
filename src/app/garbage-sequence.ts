export interface GarbageCadence {
  readonly pressureMs: number;
  readonly rowIntervalMs: number;
  readonly rowLiftMs: number;
}

export interface GarbageSequenceTiming {
  readonly impactAtMs: number;
  readonly blockingUntilMs: number;
  readonly durationMs: number;
}

export interface GarbageSequencePlan {
  readonly requestedAtMs: number;
  readonly startedAtMs: number;
  readonly rowCount: number;
  readonly cadence: GarbageCadence;
  readonly timing: GarbageSequenceTiming;
}

export interface GarbageScheduleResult {
  readonly plan: GarbageSequencePlan;
  readonly newlyScheduled: boolean;
}

export const GARBAGE_PRESSURE_MS = 80;
export const GARBAGE_ROW_INTERVAL_MS = 110;
export const GARBAGE_ROW_LIFT_MS = 140;
export const GARBAGE_FOLLOW_THROUGH_MS = 50;
export const GARBAGE_MAX_PRESENTATION_LAG_MS = 900;

export const DEFAULT_GARBAGE_CADENCE: GarbageCadence = {
  pressureMs: GARBAGE_PRESSURE_MS,
  rowIntervalMs: GARBAGE_ROW_INTERVAL_MS,
  rowLiftMs: GARBAGE_ROW_LIFT_MS,
};

const MIN_ROW_INTERVAL_MS = 45;
const TARGET_QUEUED_ROW_INTERVAL_MS = 70;
const MIN_ROW_LIFT_MS = 70;

export function garbageTimingFor(
  rowCount: number,
  cadence: GarbageCadence = DEFAULT_GARBAGE_CADENCE,
): GarbageSequenceTiming {
  const rows = Math.max(1, Math.round(rowCount));
  const blockingUntilMs = cadence.pressureMs +
    (rows - 1) * cadence.rowIntervalMs + cadence.rowLiftMs;
  return {
    impactAtMs: cadence.pressureMs,
    blockingUntilMs,
    durationMs: blockingUntilMs + GARBAGE_FOLLOW_THROUGH_MS,
  };
}

function queuedCadence(rowCount: number, actionBudgetMs: number): GarbageCadence {
  const intervals = Math.max(0, Math.round(rowCount) - 1);
  const rowIntervalMs = intervals === 0
    ? TARGET_QUEUED_ROW_INTERVAL_MS
    : Math.max(
        MIN_ROW_INTERVAL_MS,
        Math.min(
          TARGET_QUEUED_ROW_INTERVAL_MS,
          Math.floor((actionBudgetMs - MIN_ROW_LIFT_MS) / intervals),
        ),
      );
  return {
    pressureMs: 0,
    rowIntervalMs,
    rowLiftMs: Math.max(
      MIN_ROW_LIFT_MS,
      Math.min(GARBAGE_ROW_LIFT_MS, actionBudgetMs - intervals * rowIntervalMs),
    ),
  };
}

/** Plans one batch against the existing row-beat tail without exceeding the latency cap. */
export function planGarbageSequence(
  rowCount: number,
  requestedAtMs: number,
  tailBlockingAtMs = requestedAtMs,
): GarbageSequencePlan {
  const rows = Math.max(1, Math.round(rowCount));
  if (tailBlockingAtMs <= requestedAtMs) {
    const timing = garbageTimingFor(rows);
    return {
      requestedAtMs,
      startedAtMs: requestedAtMs,
      rowCount: rows,
      cadence: DEFAULT_GARBAGE_CADENCE,
      timing,
    };
  }

  const deadlineMs = requestedAtMs + GARBAGE_MAX_PRESENTATION_LAG_MS;
  const minimumActionMs = Math.max(1, rows - 1) * MIN_ROW_INTERVAL_MS +
    MIN_ROW_LIFT_MS;
  const latestStartMs = deadlineMs - minimumActionMs - GARBAGE_FOLLOW_THROUGH_MS;
  const startedAtMs = Math.max(requestedAtMs, Math.min(tailBlockingAtMs, latestStartMs));
  const actionBudgetMs = deadlineMs - startedAtMs - GARBAGE_FOLLOW_THROUGH_MS;
  const cadence = queuedCadence(rows, actionBudgetMs);
  return {
    requestedAtMs,
    startedAtMs,
    rowCount: rows,
    cadence,
    timing: garbageTimingFor(rows, cadence),
  };
}

export function garbageSeatTimes(plan: GarbageSequencePlan): number[] {
  const firstSeatAtMs = plan.startedAtMs + plan.cadence.pressureMs +
    plan.cadence.rowLiftMs;
  return Array.from(
    { length: plan.rowCount },
    (_, index) => firstSeatAtMs + index * plan.cadence.rowIntervalMs,
  );
}
