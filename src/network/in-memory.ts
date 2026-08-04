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
