/**
 * Contributor traceability:
 * Agent: Codex
 * Platform instructions: private runtime/session material intentionally omitted.
 * Runtime: Windows x64, PowerShell, OpenAgents workspace.
 */
import { EventEmitter } from "events";

export interface WsProviderConfig {
  url: string;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  listenerWarningThreshold?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface WebSocketLike {
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
  removeAllListeners?: () => void;
  listenerCount?: (event: string) => number;
}

export class WebSocketProvider extends EventEmitter {
  private url: string;
  private ws: WebSocketLike | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private subscriptions = new Map<string, (data: unknown) => void>();
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private listenerWarningThreshold: number;
  private webSocketFactory?: (url: string) => WebSocketLike;
  private reconnectCount = 0;
  private isConnected = false;

  constructor(config: WsProviderConfig) {
    super();
    this.url = config.url;
    this.reconnectInterval = config.reconnectIntervalMs ?? 3000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.listenerWarningThreshold = config.listenerWarningThreshold ?? 10;
    this.webSocketFactory = config.webSocketFactory;
  }

  async connect(): Promise<void> {
    this.cleanupSocket();

    return new Promise((resolve, reject) => {
      const socket = this.createSocket();
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.isConnected = true;
        this.reconnectCount = 0;
        this.emit("connected");
        resolve();
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        this.handleMessage(event.data);
      };

      socket.onclose = () => {
        if (this.ws !== socket) return;
        this.isConnected = false;
        this.emit("disconnected");
        this.cleanupSocket();
        this.attemptReconnect();
      };

      socket.onerror = (err) => {
        if (this.ws !== socket) return;
        if (!this.isConnected) reject(new Error("WebSocket connection failed"));
        this.emit("error", err);
      };

      this.warnIfExcessiveListeners(socket);
    });
  }

  private handleMessage(raw: string): void {
    const data = JSON.parse(raw);
    if (data.id && this.pendingRequests.has(data.id)) {
      const pending = this.pendingRequests.get(data.id)!;
      this.pendingRequests.delete(data.id);
      data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result);
    } else if (data.method === "eth_subscription") {
      const subId = data.params?.subscription;
      this.subscriptions.get(subId)?.(data.params.result);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectCount >= this.maxReconnectAttempts) {
      this.emit("maxReconnectsReached");
      return;
    }
    this.reconnectCount++;
    setTimeout(() => {
      this.connect().catch(() => this.attemptReconnect());
    }, this.reconnectInterval);
  }

  async send(method: string, params: unknown[] = []): Promise<unknown> {
    if (!this.ws || !this.isConnected) {
      throw new Error("WebSocket not connected");
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async subscribe(
    event: string,
    callback: (data: unknown) => void
  ): Promise<string> {
    const subId = (await this.send("eth_subscribe", [event])) as string;
    this.subscriptions.set(subId, callback);
    return subId;
  }

  async unsubscribe(subscriptionId: string): Promise<boolean> {
    this.subscriptions.delete(subscriptionId);
    return (await this.send("eth_unsubscribe", [subscriptionId])) as boolean;
  }

  disconnect(): void {
    this.cleanupSocket();
    this.pendingRequests.clear();
  }

  private createSocket(): WebSocketLike {
    if (this.webSocketFactory) {
      return this.webSocketFactory(this.url);
    }

    return new WebSocket(this.url) as unknown as WebSocketLike;
  }

  private cleanupSocket(): void {
    if (!this.ws) {
      return;
    }

    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.removeAllListeners?.();
    this.ws = null;
    this.isConnected = false;
  }

  private warnIfExcessiveListeners(socket: WebSocketLike): void {
    const listenerCount = socket.listenerCount?.("message") ?? 1;
    if (listenerCount > this.listenerWarningThreshold) {
      console.warn(
        `WebSocket message listener count ${listenerCount} exceeds ${this.listenerWarningThreshold}`
      );
    }
  }
}
