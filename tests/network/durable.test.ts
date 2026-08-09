import { describe, expect, it } from "vitest";

import {
  WebxdcDurableLog,
  DurableLamportClock,
  MAX_DURABLE_LOGICAL_CLOCK,
} from "../../src/network/webxdc-durable";

describe("durable Webxdc listener", () => {
  it("registers the host listener exactly once and exposes replayed serials", async () => {
    let registrations = 0;
    const received: number[] = [];
    const host = {
      selfAddr: "player-a",
      selfName: "Alice",
      sendUpdate: () => undefined,
      setUpdateListener: (
        listener: (update: { payload: unknown; serial: number; max_serial: number }) => void,
        serial = 0,
      ) => {
        registrations += 1;
        expect(serial).toBe(0);
        listener({ payload: { kind: "fixture" }, serial: 4, max_serial: 4 });
        return Promise.resolve();
      },
    };
    const log = new WebxdcDurableLog(host);

    await log.start((update) => received.push(update.serial));

    expect(received).toEqual([4]);
    expect(registrations).toBe(1);
    await expect(log.start(() => undefined)).rejects.toThrow(/once/i);
    expect(registrations).toBe(1);
  });

  it("advances an application Lamport clock past observed durable events", () => {
    const clock = new DurableLamportClock();

    expect(clock.next()).toBe(1);
    clock.observe(7);
    expect(clock.next()).toBe(8);
    clock.observe(3);
    expect(clock.next()).toBe(9);
  });

  it("rejects hostile logical clocks that would exhaust local event creation", () => {
    const clock = new DurableLamportClock();
    expect(() => clock.observe(MAX_DURABLE_LOGICAL_CLOCK + 1)).toThrow(/range/i);
    clock.observe(MAX_DURABLE_LOGICAL_CLOCK);
    expect(() => clock.next()).toThrow(/exhausted/i);
  });

  it("rejects cyclic durable payloads at the adapter boundary", async () => {
    const host = {
      selfAddr: "player-a",
      selfName: "Alice",
      sendUpdate: () => undefined,
      setUpdateListener: () => undefined,
    };
    const log = new WebxdcDurableLog(host);
    const cyclic: { payload: Record<string, unknown> } = { payload: {} };
    cyclic.payload.self = cyclic;

    await expect(log.append(cyclic)).rejects.toThrow(/cyclic|serializable/i);
  });
});
