import type { CompetitiveRealtimeTransport } from "../match/competitive-session";

export interface RealtimeChannelPort {
  setListener(listener: (data: Uint8Array) => void): void;
  send(data: Uint8Array): void;
  leave?(): void;
}

/**
 * Owns the runtime's single Webxdc realtime channel and fans received frames
 * out to independent match, spectator, and presence consumers. A consumer
 * leaving never tears down the chat-wide channel or another consumer.
 */
export class RealtimeHub {
  private channel: RealtimeChannelPort;
  private readonly listeners = new Set<(data: Uint8Array) => void>();
  private closed = false;

  public constructor(channel: RealtimeChannelPort) {
    this.channel = channel;
    this.installListener(channel);
  }

  public subscribe(listener: (data: Uint8Array) => void): () => void {
    if (this.closed) throw new Error("Realtime hub is closed");
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  public send(data: Uint8Array): void {
    if (this.closed) throw new Error("Realtime hub is closed");
    this.channel.send(data);
  }

  public transport(): CompetitiveRealtimeTransport {
    let unsubscribe: (() => void) | null = null;
    let active = true;
    return {
      setListener: (listener) => {
        if (!active) throw new Error("Realtime transport has left");
        unsubscribe?.();
        unsubscribe = this.subscribe(listener);
      },
      send: (data) => {
        if (!active) throw new Error("Realtime transport has left");
        this.send(data);
      },
      leave: () => {
        if (!active) return;
        active = false;
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.channel.leave?.();
  }

  private installListener(channel: RealtimeChannelPort): void {
    channel.setListener((data) => {
      for (const listener of [...this.listeners]) listener(data);
    });
  }
}
