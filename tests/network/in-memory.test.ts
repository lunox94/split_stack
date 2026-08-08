import { describe, expect, it } from "vitest";

import {
  ManualClock,
  ShapedRealtimeBus,
} from "../../src/network/in-memory";

describe("shaped in-memory realtime transport", () => {
  it("delivers a frame only when pumped after its one-way latency", () => {
    const clock = new ManualClock(1_000);
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", { baseLatencyMs: 50 });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const received: number[][] = [];
    b.setListener((data) => received.push([...data]));

    a.send(Uint8Array.of(1, 2, 3));
    expect(received).toEqual([]);

    clock.advance(49);
    bus.pump();
    expect(received).toEqual([]);

    clock.advance(1);
    expect(received).toEqual([]);
    expect(bus.pump()).toBe(1);
    expect(received).toEqual([[1, 2, 3]]);
  });

  it("uses scripted jitter to reproduce out-of-order delivery", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", {
      baseLatencyMs: 100,
      jitter: { kind: "script", offsetsMs: [40, -40] },
    });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const received: number[] = [];
    b.setListener((data) => received.push(data[0]!));

    a.send(Uint8Array.of(1));
    a.send(Uint8Array.of(2));

    expect(bus.advance(60)).toBe(1);
    expect(received).toEqual([2]);
    expect(bus.advance(80)).toBe(1);
    expect(received).toEqual([2, 1]);
  });

  it("uses a stable seeded jitter sequence", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", {
      baseLatencyMs: 10,
      jitter: { kind: "seeded", seed: 1, maxDeviationMs: 10 },
    });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const arrivals: Array<{ value: number; atMs: number }> = [];
    b.setListener((data) => arrivals.push({ value: data[0]!, atMs: clock.now() }));

    for (let value = 1; value <= 4; value += 1) {
      a.send(Uint8Array.of(value));
    }
    for (const stepMs of [4, 3, 3, 4]) bus.advance(stepMs);

    expect(arrivals).toEqual([
      { value: 1, atMs: 4 },
      { value: 2, atMs: 7 },
      { value: 3, atMs: 10 },
      { value: 4, atMs: 14 },
    ]);
  });

  it("applies a scripted one-way loss pattern", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", {
      baseLatencyMs: 5,
      loss: { kind: "script", drops: [true, false, true] },
    });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const received: number[] = [];
    b.setListener((data) => received.push(data[0]!));

    for (let value = 1; value <= 4; value += 1) {
      a.send(Uint8Array.of(value));
    }
    bus.advance(5);

    expect(received).toEqual([2, 4]);
  });

  it("uses a stable seeded loss sequence", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", {
      loss: { kind: "seeded", seed: 1, probability: 0.5 },
    });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const received: number[] = [];
    b.setListener((data) => received.push(data[0]!));

    for (let value = 1; value <= 4; value += 1) {
      a.send(Uint8Array.of(value));
    }
    bus.pump();

    expect(received).toEqual([3, 4]);
  });

  it("delivers scripted duplicate copies without sharing payload storage", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", {
      duplication: { extraCopies: [2] },
    });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const received: number[] = [];
    b.setListener((data) => {
      received.push(data[0]!);
      data[0] = 99;
    });
    const sent = Uint8Array.of(7);

    a.send(sent);
    sent[0] = 42;
    bus.pump();

    expect(received).toEqual([7, 7, 7]);
  });

  it("queues frames behind a deterministic token-bucket bandwidth limit", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", {
      bandwidth: {
        bytesPerSecond: 2,
        burstBytes: 2,
        maxQueuedFrames: 3,
        maxQueuedBytes: 6,
      },
    });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const received: number[] = [];
    b.setListener((data) => received.push(data[0]!));

    a.send(Uint8Array.of(1, 0));
    a.send(Uint8Array.of(2, 0));
    a.send(Uint8Array.of(3, 0));

    expect(bus.pump()).toBe(1);
    expect(received).toEqual([1]);
    expect(bus.advance(999)).toBe(0);
    expect(bus.advance(1)).toBe(1);
    expect(bus.advance(1_000)).toBe(1);
    expect(received).toEqual([1, 2, 3]);
  });

  it("shapes the two route directions independently", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", { baseLatencyMs: 10 });
    bus.configureRoute("b", "a", { baseLatencyMs: 100 });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const receivedByA: number[] = [];
    const receivedByB: number[] = [];
    a.setListener((data) => receivedByA.push(data[0]!));
    b.setListener((data) => receivedByB.push(data[0]!));

    a.send(Uint8Array.of(1));
    b.send(Uint8Array.of(2));

    bus.advance(10);
    expect(receivedByA).toEqual([]);
    expect(receivedByB).toEqual([1]);
    bus.advance(90);
    expect(receivedByA).toEqual([2]);
  });

  it("drops newest frames when a bounded route queue is full", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", {
      bandwidth: {
        bytesPerSecond: 1,
        burstBytes: 1,
        maxQueuedFrames: 2,
        maxQueuedBytes: 100,
      },
    });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const received: number[] = [];
    b.setListener((data) => received.push(data[0]!));

    a.send(Uint8Array.of(1));
    a.send(Uint8Array.of(2));
    a.send(Uint8Array.of(3));
    bus.pump();
    a.send(Uint8Array.of(4));
    bus.advance(2_000);

    expect(received).toEqual([1, 2, 4]);
  });

  it("also bounds queued payload bytes", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", {
      bandwidth: {
        bytesPerSecond: 1_000,
        burstBytes: 0,
        maxQueuedFrames: 10,
        maxQueuedBytes: 2,
      },
    });
    const a = bus.connect("a");
    const b = bus.connect("b");
    const received: number[] = [];
    b.setListener((data) => received.push(data[0]!));

    a.send(Uint8Array.of(1, 0));
    a.send(Uint8Array.of(2));
    bus.advance(2);

    expect(received).toEqual([1]);
  });

  it("drains due zero-latency replies even when future frames are queued", () => {
    const clock = new ManualClock();
    const bus = new ShapedRealtimeBus(clock);
    bus.configureRoute("a", "b", { baseLatencyMs: 0 });
    bus.configureRoute("a", "c", { baseLatencyMs: 100 });
    bus.configureRoute("b", "a", { baseLatencyMs: 0 });
    bus.configureRoute("b", "c", { baseLatencyMs: 100 });
    const a = bus.connect("a");
    const b = bus.connect("b");
    bus.connect("c");
    const receivedByA: number[] = [];
    a.setListener((data) => receivedByA.push(data[0]!));
    b.setListener(() => b.send(Uint8Array.of(2)));

    a.send(Uint8Array.of(1));

    expect(bus.pump()).toBe(2);
    expect(receivedByA).toEqual([2]);
  });
});
