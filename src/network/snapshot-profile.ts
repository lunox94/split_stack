export type SnapshotHz = 10 | 5 | 2 | 0;

export interface SnapshotProfile {
  readonly hz: SnapshotHz;
  readonly intervalTicks: 6 | 12 | 30 | null;
}

/**
 * Parses the build-time snapshot-rate experiment without changing match rules.
 * A zero rate disables only periodic snapshots; critical recovery and terminal
 * state still travel through forced snapshots owned by CompetitiveSession.
 */
export function parseSnapshotProfile(
  value: string | undefined,
): SnapshotProfile {
  switch (value ?? "10") {
    case "10":
      return { hz: 10, intervalTicks: 6 };
    case "5":
      return { hz: 5, intervalTicks: 12 };
    case "2":
      return { hz: 2, intervalTicks: 30 };
    case "0":
      return { hz: 0, intervalTicks: null };
    default:
      throw new RangeError(
        "VITE_SPLIT_STACK_SNAPSHOT_HZ must be one of 10, 5, 2, or 0",
      );
  }
}
