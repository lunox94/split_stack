import { RULES } from "../config/rules";
import { deriveEventUint32 } from "./rng";
import type { BarrierStatus, GarbagePacket, Grid } from "./types";

export interface CancellationResult {
  incoming: GarbagePacket[];
  outgoingRows: number;
}

function orderedPackets(incoming: readonly GarbagePacket[]): GarbagePacket[] {
  return incoming
    .map((packet, index) => ({ packet: { ...packet }, index }))
    .sort((left, right) =>
      left.packet.readyTick === right.packet.readyTick
        ? left.index - right.index
        : left.packet.readyTick - right.packet.readyTick,
    )
    .map(({ packet }) => packet);
}

export function cancelIncomingGarbage(
  incoming: readonly GarbagePacket[],
  outgoingRows: number,
): CancellationResult {
  let remaining = Math.max(0, Math.floor(outgoingRows));
  const queue = orderedPackets(incoming);
  for (const packet of queue) {
    if (remaining === 0) break;
    const canceled = Math.min(packet.rows, remaining);
    packet.rows -= canceled;
    remaining -= canceled;
  }
  return {
    incoming: queue.filter((packet) => packet.rows > 0),
    outgoingRows: remaining,
  };
}

export function createGarbagePacket(
  seed: string,
  eventId: string,
  rows: number,
  readyTick: number,
  previousHole: number | null,
  senderId?: string,
): GarbagePacket {
  let hole = deriveEventUint32(seed, eventId, "garbage-hole") % RULES.board.width;
  if (!RULES.garbage.holePolicy.allowConsecutiveRepeat && hole === previousHole) {
    const alternate =
      deriveEventUint32(seed, eventId, "garbage-hole-reroll") % (RULES.board.width - 1);
    hole = alternate >= previousHole ? alternate + 1 : alternate;
  }
  const packet: GarbagePacket = {
    id: eventId,
    rows: Math.max(0, Math.floor(rows)),
    readyTick: Math.max(0, Math.floor(readyTick)),
    hole,
  };
  if (senderId !== undefined) packet.senderId = senderId;
  return packet;
}

export interface AppliedGarbage {
  grid: Grid;
  incoming: GarbagePacket[];
  barrier: BarrierStatus | null;
  appliedRows: number;
  blockedRows: number;
  topOut: boolean;
}

function cloneGrid(grid: Grid): Grid {
  return grid.map((row) => row.map((cell) => (cell === null ? null : { ...cell })));
}

function riseOneRow(grid: Grid, hole: number): void {
  for (let row = 0; row < RULES.board.height - 1; row += 1) {
    grid[row] = grid[row + 1] as Grid[number];
  }
  grid[RULES.board.height - 1] = Array.from(
    { length: RULES.board.width },
    (_, column) => (column === hole ? null : { kind: "garbage" as const }),
  );
}

export function applyReadyGarbage(
  sourceGrid: Grid,
  incoming: readonly GarbagePacket[],
  currentTick: number,
  activeBarrier: BarrierStatus | null,
): AppliedGarbage {
  const grid = cloneGrid(sourceGrid);
  const queue = orderedPackets(incoming);
  const barrier = activeBarrier === null ? null : { ...activeBarrier };
  let attempts = 0;
  let appliedRows = 0;
  let blockedRows = 0;
  let topOut = false;

  for (const packet of queue) {
    while (
      packet.rows > 0 &&
      packet.readyTick <= currentTick &&
      attempts < RULES.garbage.rowsPerLockCap &&
      !topOut
    ) {
      attempts += 1;
      packet.rows -= 1;

      if (barrier !== null && barrier.remainingTicks > 0 && barrier.capacity > 0) {
        barrier.capacity -= 1;
        blockedRows += 1;
        continue;
      }

      if (grid[0]?.some((cell) => cell !== null) === true) {
        topOut = true;
        break;
      }

      riseOneRow(grid, packet.hole);
      appliedRows += 1;
    }
    if (attempts >= RULES.garbage.rowsPerLockCap || topOut) break;
  }

  return {
    grid,
    incoming: queue.filter((packet) => packet.rows > 0),
    barrier,
    appliedRows,
    blockedRows,
    topOut,
  };
}
