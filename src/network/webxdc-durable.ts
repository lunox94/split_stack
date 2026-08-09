export interface DurableReceivedUpdate<T = unknown> {
  payload: T;
  serial: number;
  max_serial: number;
  info?: string;
  href?: string;
  summary?: string;
  notify?: Record<string, string>;
}

export interface DurableOutboundUpdate<T> {
  payload: T;
  info?: string;
  href?: string;
  summary?: string;
  notify?: Record<string, string>;
}

export interface DurableWebxdcHost<T = unknown> {
  selfAddr: string;
  selfName: string;
  sendUpdateInterval?: number;
  sendUpdateMaxSize?: number;
  sendUpdate(update: DurableOutboundUpdate<T>, description: string): void | Promise<void>;
  setUpdateListener(
    listener: (update: DurableReceivedUpdate<T>) => void,
    serial?: number,
  ): void | Promise<void>;
}

const DEFAULT_MAX_UPDATE_BYTES = 128_000;
const MAX_DURABLE_DEPTH = 8;
export const MAX_DURABLE_LOGICAL_CLOCK = 0x7fff_ffff;

export class DurableLamportClock {
  private value = 0;

  public observe(remoteValue: number): void {
    if (
      !Number.isSafeInteger(remoteValue) ||
      remoteValue < 0 ||
      remoteValue > MAX_DURABLE_LOGICAL_CLOCK
    ) {
      throw new RangeError("Lamport clock value is outside the supported range");
    }
    this.value = Math.max(this.value, remoteValue);
  }

  public next(): number {
    if (this.value >= MAX_DURABLE_LOGICAL_CLOCK) {
      throw new RangeError("Lamport clock exhausted its supported range");
    }
    this.value += 1;
    return this.value;
  }
}

function depthOf(value: unknown, current = 0, seen = new WeakSet<object>()): number {
  if (value === null || typeof value !== "object") return current;
  if (seen.has(value)) return Number.POSITIVE_INFINITY;
  if (current > MAX_DURABLE_DEPTH) return current;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  let maximum = current;
  try {
    for (const child of children) {
      maximum = Math.max(maximum, depthOf(child, current + 1, seen));
      if (maximum > MAX_DURABLE_DEPTH) return maximum;
    }
  } finally {
    seen.delete(value);
  }
  return maximum;
}

/**
 * Owns the process-wide setUpdateListener registration. The Webxdc API declares
 * repeated registration undefined, so consumers must fan out above this seam.
 */
export class WebxdcDurableLog<T = unknown> {
  private started = false;

  public constructor(private readonly host: DurableWebxdcHost<T>) {}

  public async start(
    listener: (update: DurableReceivedUpdate<T>) => void,
    lastKnownSerial = 0,
  ): Promise<void> {
    if (this.started) throw new Error("Durable update listener may be started only once");
    if (!Number.isSafeInteger(lastKnownSerial) || lastKnownSerial < 0) {
      throw new RangeError("Durable replay serial must be a non-negative integer");
    }
    this.started = true;
    await this.host.setUpdateListener(listener, lastKnownSerial);
  }

  public async append(update: DurableOutboundUpdate<T>): Promise<void> {
    const depth = depthOf(update);
    if (!Number.isFinite(depth)) {
      throw new TypeError("Durable update must be acyclic and JSON serializable");
    }
    if (depth > MAX_DURABLE_DEPTH) {
      throw new RangeError("Durable update exceeds maximum object depth");
    }
    let encoded: Uint8Array;
    try {
      encoded = new TextEncoder().encode(JSON.stringify(update));
    } catch {
      throw new TypeError("Durable update must be JSON serializable");
    }
    const maximum = this.host.sendUpdateMaxSize ?? DEFAULT_MAX_UPDATE_BYTES;
    if (encoded.byteLength > maximum) {
      throw new RangeError("Durable update exceeds host size limit");
    }
    // The legacy description parameter remains an empty string for old hosts.
    await this.host.sendUpdate(update, "");
  }
}
