interface WebxdcUpdate<T = unknown> {
  payload: T;
  info?: string;
  href?: string;
  document?: string;
  summary?: string;
  notify?: Record<string, string>;
}

interface WebxdcReceivedUpdate<T = unknown> extends WebxdcUpdate<T> {
  serial: number;
  max_serial: number;
}

interface WebxdcRealtimeChannel {
  setListener(listener: (data: Uint8Array) => void): void;
  send(data: Uint8Array): void;
  leave?(): void;
}

interface WebxdcHost {
  selfAddr: string;
  selfName: string;
  sendUpdateInterval: number;
  sendUpdateMaxSize: number;
  sendUpdate(update: WebxdcUpdate, description: string): Promise<void>;
  setUpdateListener(
    listener: (update: WebxdcReceivedUpdate) => void,
    serial?: number,
  ): void;
  joinRealtimeChannel?(): WebxdcRealtimeChannel;
}

interface Window {
  webxdc?: WebxdcHost;
}
