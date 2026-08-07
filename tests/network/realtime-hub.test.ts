import { describe, expect, it } from "vitest";

import {
  RealtimeHub,
  type RealtimeChannelPort,
} from "../../src/network/realtime-hub";

function channel() {
  let listener: ((data: Uint8Array) => void) | undefined;
  const sent: number[][] = [];
  let leaves = 0;
  const port: RealtimeChannelPort = {
    setListener: (next) => {
      if (listener !== undefined) throw new Error("listener already installed");
      listener = next;
    },
    send: (data) => sent.push([...data]),
    leave: () => {
      leaves += 1;
    },
  };
  return {
    port,
    emit: (values: number[]) => listener?.(Uint8Array.from(values)),
    sent,
    leaves: () => leaves,
  };
}

describe("chat-wide realtime hub", () => {
  it("fans frames out without one consumer leaving another", () => {
    const backing = channel();
    const hub = new RealtimeHub(backing.port);
    const first: number[][] = [];
    const second: number[][] = [];
    const leaveFirst = hub.subscribe((data) => first.push([...data]));
    hub.subscribe((data) => second.push([...data]));

    backing.emit([1]);
    leaveFirst();
    backing.emit([2]);

    expect(first).toEqual([[1]]);
    expect(second).toEqual([[1], [2]]);
    expect(backing.leaves()).toBe(0);
  });

  it("gives sessions independent facades over one backing listener", () => {
    const backing = channel();
    const hub = new RealtimeHub(backing.port);
    const first = hub.transport();
    const second = hub.transport();
    const received: number[][] = [];
    first.setListener(() => undefined);
    second.setListener((data) => received.push([...data]));

    first.leave();
    second.send(Uint8Array.of(9));
    backing.emit([4]);

    expect(received).toEqual([[4]]);
    expect(backing.sent).toEqual([[9]]);
    expect(backing.leaves()).toBe(0);
  });

  it("keeps four match consumers flowing when their spectators disconnect", () => {
    const backing = channel();
    const hub = new RealtimeHub(backing.port);
    const playerFrames = Array.from({ length: 4 }, () => [] as number[][]);
    const spectatorFrames = Array.from({ length: 4 }, () => [] as number[][]);
    const playerTransports = playerFrames.map((frames, matchIndex) => {
      const transport = hub.transport();
      transport.setListener((data) => {
        if (data[0] === matchIndex) frames.push([...data]);
      });
      return transport;
    });
    const spectatorTransports = spectatorFrames.map((frames, matchIndex) => {
      const transport = hub.transport();
      transport.setListener((data) => {
        if (data[0] === matchIndex) frames.push([...data]);
      });
      return transport;
    });

    for (let matchIndex = 0; matchIndex < 4; matchIndex += 1) {
      backing.emit([matchIndex, 1]);
    }
    for (const transport of spectatorTransports) transport.leave();
    for (let matchIndex = 0; matchIndex < 4; matchIndex += 1) {
      backing.emit([matchIndex, 2]);
      playerTransports[matchIndex]?.send(Uint8Array.of(matchIndex, 3));
    }

    expect(playerFrames).toEqual([
      [[0, 1], [0, 2]],
      [[1, 1], [1, 2]],
      [[2, 1], [2, 2]],
      [[3, 1], [3, 2]],
    ]);
    expect(spectatorFrames).toEqual([
      [[0, 1]],
      [[1, 1]],
      [[2, 1]],
      [[3, 1]],
    ]);
    expect(backing.sent).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
    expect(backing.leaves()).toBe(0);
  });
});
