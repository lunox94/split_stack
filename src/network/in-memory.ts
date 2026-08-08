import type { MonotonicClock } from "./clock";

export class ManualClock implements MonotonicClock {
  public constructor(private currentMs = 0) {
    if (!Number.isFinite(currentMs) || currentMs < 0) {
      throw new RangeError("Manual clock time must be non-negative");
    }
  }

  public now(): number {
    return this.currentMs;
  }

  public advance(milliseconds: number): number {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("Manual clock cannot move backwards");
    }
    this.currentMs += milliseconds;
    return this.currentMs;
  }
}

export interface InMemoryRealtimeEndpoint {
  setListener(listener: (data: Uint8Array) => void): void;
  send(data: Uint8Array): void;
  leave(): void;
}

export type ShapedRealtimeJitter =
  | {
      kind: "script";
      /** Signed offsets consumed once per frame; exhaustion falls back to zero. */
      offsetsMs: readonly number[];
      repeat?: boolean;
    }
  | {
      kind: "seeded";
      /** Seed for the stable Numerical Recipes 32-bit LCG. */
      seed: number;
      /** Inclusive integer range is `-maxDeviationMs...maxDeviationMs`. */
      maxDeviationMs: number;
    };

export type ShapedRealtimeLoss =
  | {
      kind: "script";
      /** `true` drops that frame; exhaustion falls back to delivery. */
      drops: readonly boolean[];
      repeat?: boolean;
    }
  | {
      kind: "seeded";
      seed: number;
      /** Drop probability in the inclusive range 0...1. */
      probability: number;
    };

export interface ShapedRealtimeDuplication {
  /** Number of extra deliveries consumed once per original frame. */
  extraCopies: readonly number[];
  repeat?: boolean;
}

export interface ShapedRealtimeBandwidth {
  bytesPerSecond: number;
  /** Initial and maximum idle credit; defaults to one second of bandwidth. */
  burstBytes?: number;
  /** Bounds all accepted deliveries not yet released by `pump()`. */
  maxQueuedFrames?: number;
  maxQueuedBytes?: number;
}

export interface ShapedRealtimeRouteOptions {
  /** Fixed propagation delay for this direction. */
  baseLatencyMs?: number;
  jitter?: ShapedRealtimeJitter;
  loss?: ShapedRealtimeLoss;
  duplication?: ShapedRealtimeDuplication;
  bandwidth?: ShapedRealtimeBandwidth;
}

interface NormalizedBandwidth {
  bytesPerSecond: number;
  burstBytes: number;
  maxQueuedFrames: number;
  maxQueuedBytes: number;
}

interface ShapedRouteState {
  options: ShapedRealtimeRouteOptions;
  jitterIndex: number;
  jitterState: number;
  lossIndex: number;
  lossState: number;
  duplicationIndex: number;
  bandwidth: NormalizedBandwidth | undefined;
  bandwidthCursorMs: number;
  bandwidthTokens: number;
  queuedFrames: number;
  queuedBytes: number;
}

interface ScheduledDelivery {
  to: string;
  data: Uint8Array;
  dueAtMs: number;
  order: number;
  queuedRoute?: ShapedRouteState;
}

/**
 * Deterministic test transport whose queued frames move only when `pump()` is
 * called. Routes are directional so asymmetric links can be modeled directly.
 */
export class ShapedRealtimeBus {
  private readonly listeners = new Map<string, (data: Uint8Array) => void>();
  private readonly routes = new Map<string, ShapedRouteState>();
  private readonly scheduled: ScheduledDelivery[] = [];
  private nextOrder = 0;

  public constructor(private readonly clock: ManualClock) {}

  public configureRoute(
    from: string,
    to: string,
    options: ShapedRealtimeRouteOptions,
  ): void {
    const baseLatencyMs = options.baseLatencyMs ?? 0;
    if (!Number.isFinite(baseLatencyMs) || baseLatencyMs < 0) {
      throw new RangeError("Route latency must be non-negative");
    }
    if (
      options.jitter?.kind === "script" &&
      options.jitter.offsetsMs.some((offset) => !Number.isFinite(offset))
    ) {
      throw new RangeError("Route jitter offsets must be finite");
    }
    if (options.jitter?.kind === "seeded") {
      if (
        !Number.isInteger(options.jitter.seed) ||
        options.jitter.seed < 0 ||
        options.jitter.seed > 0xffff_ffff
      ) {
        throw new RangeError("Route jitter seed must be a 32-bit unsigned integer");
      }
      if (
        !Number.isInteger(options.jitter.maxDeviationMs) ||
        options.jitter.maxDeviationMs < 0
      ) {
        throw new RangeError("Route jitter deviation must be a non-negative integer");
      }
    }
    if (
      options.loss?.kind === "script" &&
      options.loss.drops.some((drop) => typeof drop !== "boolean")
    ) {
      throw new TypeError("Route loss script entries must be boolean");
    }
    if (options.loss?.kind === "seeded") {
      if (
        !Number.isInteger(options.loss.seed) ||
        options.loss.seed < 0 ||
        options.loss.seed > 0xffff_ffff
      ) {
        throw new RangeError("Route loss seed must be a 32-bit unsigned integer");
      }
      if (
        !Number.isFinite(options.loss.probability) ||
        options.loss.probability < 0 ||
        options.loss.probability > 1
      ) {
        throw new RangeError("Route loss probability must be between zero and one");
      }
    }
    if (
      options.duplication?.extraCopies.some(
        (copies) => !Number.isInteger(copies) || copies < 0,
      )
    ) {
      throw new RangeError("Route duplicate counts must be non-negative integers");
    }
    const bandwidth = this.normalizeBandwidth(options.bandwidth);
    this.routes.set(routeKey(from, to), {
      options: { ...options, baseLatencyMs },
      jitterIndex: 0,
      jitterState: options.jitter?.kind === "seeded" ? options.jitter.seed : 0,
      lossIndex: 0,
      lossState: options.loss?.kind === "seeded" ? options.loss.seed : 0,
      duplicationIndex: 0,
      bandwidth,
      bandwidthCursorMs: this.clock.now(),
      bandwidthTokens: bandwidth?.burstBytes ?? 0,
      queuedFrames: 0,
      queuedBytes: 0,
    });
  }

  public connect(endpointId: string): InMemoryRealtimeEndpoint {
    if (this.listeners.has(endpointId)) {
      throw new Error(`Endpoint ${endpointId} is already connected`);
    }
    this.listeners.set(endpointId, () => undefined);
    let active = true;
    return {
      setListener: (listener) => {
        if (!active) throw new Error("Realtime endpoint has left the channel");
        this.listeners.set(endpointId, listener);
      },
      send: (data) => {
        if (!active) throw new Error("Realtime endpoint has left the channel");
        this.broadcast(endpointId, data);
      },
      leave: () => {
        if (!active) return;
        active = false;
        this.listeners.delete(endpointId);
      },
    };
  }

  public pump(): number {
    const nowMs = this.clock.now();
    let delivered = 0;
    while (this.scheduled.length > 0) {
      this.scheduled.sort(
        (left, right) => left.dueAtMs - right.dueAtMs || left.order - right.order,
      );
      if (this.scheduled[0]!.dueAtMs > nowMs) break;
      const delivery = this.scheduled.shift()!;
      if (delivery.queuedRoute !== undefined) {
        delivery.queuedRoute.queuedFrames -= 1;
        delivery.queuedRoute.queuedBytes -= delivery.data.byteLength;
      }
      const listener = this.listeners.get(delivery.to);
      if (listener === undefined) continue;
      listener(delivery.data);
      delivered += 1;
    }
    return delivered;
  }

  public advance(milliseconds: number): number {
    this.clock.advance(milliseconds);
    return this.pump();
  }

  private broadcast(from: string, data: Uint8Array): void {
    for (const to of this.listeners.keys()) {
      if (to === from) continue;
      const route = this.routes.get(routeKey(from, to));
      if (route !== undefined && this.nextDrop(route)) continue;
      const baseLatencyMs = route?.options.baseLatencyMs ?? 0;
      const copies = 1 + (route === undefined ? 0 : this.nextExtraCopies(route));
      for (let copy = 0; copy < copies; copy += 1) {
        if (route !== undefined && !this.acceptQueue(route, data.byteLength)) {
          continue;
        }
        const jitterMs = route === undefined ? 0 : this.nextJitter(route);
        const departureAtMs =
          route === undefined
            ? this.clock.now()
            : this.reserveBandwidth(route, data.byteLength);
        const delivery: ScheduledDelivery = {
          to,
          data: data.slice(),
          dueAtMs: departureAtMs + Math.max(0, baseLatencyMs + jitterMs),
          order: this.nextOrder,
        };
        if (route?.bandwidth !== undefined) delivery.queuedRoute = route;
        this.scheduled.push(delivery);
        this.nextOrder += 1;
      }
    }
  }

  private nextJitter(route: ShapedRouteState): number {
    const jitter = route.options.jitter;
    if (jitter === undefined) return 0;
    if (jitter.kind === "seeded") {
      route.jitterState =
        (Math.imul(1_664_525, route.jitterState) + 1_013_904_223) >>> 0;
      const width = jitter.maxDeviationMs * 2 + 1;
      return (
        Math.floor((route.jitterState / 0x1_0000_0000) * width) -
        jitter.maxDeviationMs
      );
    }
    if (jitter.offsetsMs.length === 0) return 0;
    const index = jitter.repeat
      ? route.jitterIndex % jitter.offsetsMs.length
      : route.jitterIndex;
    route.jitterIndex += 1;
    return jitter.offsetsMs[index] ?? 0;
  }

  private nextDrop(route: ShapedRouteState): boolean {
    const loss = route.options.loss;
    if (loss === undefined) return false;
    if (loss.kind === "seeded") {
      route.lossState =
        (Math.imul(1_664_525, route.lossState) + 1_013_904_223) >>> 0;
      return route.lossState / 0x1_0000_0000 < loss.probability;
    }
    if (loss.drops.length === 0) return false;
    const index = loss.repeat
      ? route.lossIndex % loss.drops.length
      : route.lossIndex;
    route.lossIndex += 1;
    return loss.drops[index] ?? false;
  }

  private nextExtraCopies(route: ShapedRouteState): number {
    const duplication = route.options.duplication;
    if (duplication === undefined || duplication.extraCopies.length === 0) {
      return 0;
    }
    const index = duplication.repeat
      ? route.duplicationIndex % duplication.extraCopies.length
      : route.duplicationIndex;
    route.duplicationIndex += 1;
    return duplication.extraCopies[index] ?? 0;
  }

  private normalizeBandwidth(
    bandwidth: ShapedRealtimeBandwidth | undefined,
  ): NormalizedBandwidth | undefined {
    if (bandwidth === undefined) return undefined;
    if (!Number.isFinite(bandwidth.bytesPerSecond) || bandwidth.bytesPerSecond <= 0) {
      throw new RangeError("Route bandwidth must be positive");
    }
    const burstBytes = bandwidth.burstBytes ?? bandwidth.bytesPerSecond;
    const maxQueuedFrames = bandwidth.maxQueuedFrames ?? 256;
    const maxQueuedBytes = bandwidth.maxQueuedBytes ?? 1_048_576;
    if (!Number.isFinite(burstBytes) || burstBytes < 0) {
      throw new RangeError("Route bandwidth burst must be non-negative");
    }
    if (!Number.isInteger(maxQueuedFrames) || maxQueuedFrames < 0) {
      throw new RangeError("Route frame queue bound must be a non-negative integer");
    }
    if (!Number.isInteger(maxQueuedBytes) || maxQueuedBytes < 0) {
      throw new RangeError("Route byte queue bound must be a non-negative integer");
    }
    return {
      bytesPerSecond: bandwidth.bytesPerSecond,
      burstBytes,
      maxQueuedFrames,
      maxQueuedBytes,
    };
  }

  private acceptQueue(route: ShapedRouteState, byteLength: number): boolean {
    const bandwidth = route.bandwidth;
    if (bandwidth === undefined) return true;
    if (
      route.queuedFrames >= bandwidth.maxQueuedFrames ||
      route.queuedBytes + byteLength > bandwidth.maxQueuedBytes
    ) {
      return false;
    }
    route.queuedFrames += 1;
    route.queuedBytes += byteLength;
    return true;
  }

  private reserveBandwidth(route: ShapedRouteState, byteLength: number): number {
    const bandwidth = route.bandwidth;
    if (bandwidth === undefined) return this.clock.now();
    const nowMs = this.clock.now();
    if (nowMs >= route.bandwidthCursorMs) {
      const refill =
        ((nowMs - route.bandwidthCursorMs) * bandwidth.bytesPerSecond) / 1_000;
      route.bandwidthTokens = Math.min(
        bandwidth.burstBytes,
        route.bandwidthTokens + refill,
      );
      route.bandwidthCursorMs = nowMs;
    }
    if (route.bandwidthTokens >= byteLength) {
      route.bandwidthTokens -= byteLength;
      return route.bandwidthCursorMs;
    }
    const missingBytes = byteLength - route.bandwidthTokens;
    route.bandwidthTokens = 0;
    route.bandwidthCursorMs +=
      (missingBytes * 1_000) / bandwidth.bytesPerSecond;
    return route.bandwidthCursorMs;
  }
}

interface RouteFaults {
  drops: number;
  duplicateExtraCopies: number;
  delays: number;
}

interface DelayedDelivery {
  to: string;
  data: Uint8Array;
}

interface HeldRoute {
  from: string;
  to: string;
  predicate: (data: Uint8Array) => boolean;
  deliveries: DelayedDelivery[];
}

function routeKey(from: string, to: string): string {
  return `${from.length}:${from}${to.length}:${to}`;
}

/**
 * Test-only broadcast transport. It intentionally has no sender metadata at the
 * listener boundary, matching joinRealtimeChannel rather than a WebSocket API.
 */
export class InMemoryRealtimeBus {
  private readonly listeners = new Map<string, (data: Uint8Array) => void>();
  private readonly faults = new Map<string, RouteFaults>();
  private readonly delayed: DelayedDelivery[] = [];
  private readonly heldRoutes = new Map<number, HeldRoute>();
  private nextHoldId = 1;

  public connect(endpointId: string): InMemoryRealtimeEndpoint {
    if (this.listeners.has(endpointId)) {
      throw new Error(`Endpoint ${endpointId} is already connected`);
    }
    this.listeners.set(endpointId, () => undefined);
    let active = true;
    return {
      setListener: (listener) => {
        if (!active) throw new Error("Realtime endpoint has left the channel");
        this.listeners.set(endpointId, listener);
      },
      send: (data) => {
        if (!active) throw new Error("Realtime endpoint has left the channel");
        this.broadcast(endpointId, data);
      },
      leave: () => {
        if (!active) return;
        active = false;
        this.listeners.delete(endpointId);
      },
    };
  }

  public dropNext(from: string, to: string, count = 1): void {
    this.fault(from, to).drops += count;
  }

  public duplicateNext(from: string, to: string, extraCopies = 1): void {
    this.fault(from, to).duplicateExtraCopies += extraCopies;
  }

  public delayNext(from: string, to: string, count = 1): void {
    this.fault(from, to).delays += count;
  }

  public releaseDelayed(reverse = false): void {
    const deliveries = this.delayed.splice(0);
    if (reverse) deliveries.reverse();
    for (const delivery of deliveries) this.deliver(delivery.to, delivery.data);
  }

  public holdMatching(
    from: string,
    to: string,
    predicate: (data: Uint8Array) => boolean,
  ): number {
    const holdId = this.nextHoldId;
    this.nextHoldId += 1;
    this.heldRoutes.set(holdId, { from, to, predicate, deliveries: [] });
    return holdId;
  }

  public releaseHeld(holdId: number, reverse = false): void {
    const held = this.heldRoutes.get(holdId);
    if (held === undefined) return;
    this.heldRoutes.delete(holdId);
    const deliveries = held.deliveries.splice(0);
    if (reverse) deliveries.reverse();
    for (const delivery of deliveries) this.deliver(delivery.to, delivery.data);
  }

  public discardHeld(holdId: number): void {
    this.heldRoutes.delete(holdId);
  }

  private fault(from: string, to: string): RouteFaults {
    const key = routeKey(from, to);
    let fault = this.faults.get(key);
    if (fault === undefined) {
      fault = { drops: 0, duplicateExtraCopies: 0, delays: 0 };
      this.faults.set(key, fault);
    }
    return fault;
  }

  private broadcast(from: string, data: Uint8Array): void {
    for (const to of this.listeners.keys()) {
      if (to === from) continue;
      const held = [...this.heldRoutes.values()].find(
        (route) =>
          route.from === from &&
          route.to === to &&
          route.predicate(data),
      );
      if (held !== undefined) {
        held.deliveries.push({ to, data: data.slice() });
        continue;
      }
      const fault = this.fault(from, to);
      if (fault.drops > 0) {
        fault.drops -= 1;
        continue;
      }
      const copies = 1 + fault.duplicateExtraCopies;
      fault.duplicateExtraCopies = 0;
      for (let copy = 0; copy < copies; copy += 1) {
        const cloned = data.slice();
        if (fault.delays > 0) {
          fault.delays -= 1;
          this.delayed.push({ to, data: cloned });
        } else {
          this.deliver(to, cloned);
        }
      }
    }
  }

  private deliver(to: string, data: Uint8Array): void {
    this.listeners.get(to)?.(data);
  }
}
