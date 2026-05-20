/**
 * @contributor: Codex
 * @timestamp: 2026-05-20T01:49:25.9722058-05:00
 * @platform-config: private platform/session initialization text intentionally omitted
 * @runtime: os=windows, arch=x64, home_dir=C:\Users\Ben, working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents, shell=powershell
 */

import { EventEmitter } from "events";

export interface WsProviderConfig {
  url: string;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  messageQueueLimit?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface QueuedRequest extends PendingRequest {
  method: string;
  params: unknown[];
}

interface ActiveSubscription {
  event: string;
  callback: (data: unknown) => void;
}

export class WebSocketProvider extends EventEmitter {
  private url: string;
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private subscriptions = new Map<string, ActiveSubscription>();
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private messageQueueLimit: number;
  private heartbeatIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatRequestId: number | null = null;
  private heartbeatSentAt = 0;
  private reconnectCount = 0;
  private isConnected = false;
  private manualDisconnect = false;
  private messageQueue: QueuedRequest[] = [];

  constructor(config: WsProviderConfig) {
    super();
    this.url = config.url;
    this.reconnectInterval = config.reconnectIntervalMs ?? 3000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.messageQueueLimit = config.messageQueueLimit ?? 100;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimeoutMs =
      config.heartbeatTimeoutMs ?? this.heartbeatIntervalMs;
  }

  async connect(): Promise<void> {
    this.manualDisconnect = false;
    this.clearReconnectTimer();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectCount = 0;
        this.startHeartbeat();
        void this.resubscribeActiveSubscriptions();
        this.flushMessageQueue();
        this.emit("connected");
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.stopHeartbeat();
        this.emit("disconnected");
        if (!this.manualDisconnect) {
          this.attemptReconnect();
        }
      };

      this.ws.onerror = (err) => {
        if (!this.isConnected) reject(new Error("WebSocket connection failed"));
        this.emit("error", err);
      };
    });
  }

  private handleMessage(rawData: string): void {
    let data: any;
    try {
      data = JSON.parse(rawData);
    } catch {
      if (rawData === "pong") {
        this.markHeartbeatPong();
      }
      return;
    }

    if (
      data.method === "pong" ||
      (data.id === this.heartbeatRequestId && data.result === "pong")
    ) {
      this.markHeartbeatPong();
      return;
    }

    if (data.id && this.pendingRequests.has(data.id)) {
      const pending = this.pendingRequests.get(data.id)!;
      this.pendingRequests.delete(data.id);
      data.error ? pending.reject(new Error(data.error.message)) : pending.resolve(data.result);
    } else if (data.method === "eth_subscription") {
      const subId = data.params?.subscription;
      this.subscriptions.get(subId)?.callback(data.params.result);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || !this.isConnected) {
        return;
      }

      if (
        this.heartbeatRequestId !== null &&
        Date.now() - this.heartbeatSentAt >= this.heartbeatTimeoutMs
      ) {
        this.emit("heartbeatTimeout");
        this.ws.close();
        return;
      }

      this.heartbeatRequestId = ++this.requestId;
      this.heartbeatSentAt = Date.now();
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this.heartbeatRequestId,
          method: "ping",
          params: [],
        })
      );
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatRequestId = null;
    this.heartbeatSentAt = 0;
  }

  private markHeartbeatPong(): void {
    this.heartbeatRequestId = null;
    this.heartbeatSentAt = 0;
  }

  private attemptReconnect(): void {
    if (this.reconnectCount >= this.maxReconnectAttempts) {
      this.rejectQueuedRequests(new Error("WebSocket reconnect attempts exhausted"));
      this.emit("maxReconnectsReached");
      return;
    }

    this.reconnectCount++;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.attemptReconnect());
    }, this.reconnectInterval);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private flushMessageQueue(): void {
    const queue = this.messageQueue;
    this.messageQueue = [];

    for (const queued of queue) {
      this.send(queued.method, queued.params)
        .then(queued.resolve)
        .catch(queued.reject);
    }
  }

  private async resubscribeActiveSubscriptions(): Promise<void> {
    if (this.subscriptions.size === 0) {
      return;
    }

    const activeSubscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();

    for (const subscription of activeSubscriptions) {
      try {
        const subId = (await this.send("eth_subscribe", [
          subscription.event,
        ])) as string;
        this.subscriptions.set(subId, subscription);
      } catch (error) {
        this.emit("error", error);
      }
    }
  }

  private rejectQueuedRequests(error: Error): void {
    const queue = this.messageQueue;
    this.messageQueue = [];
    for (const queued of queue) {
      queued.reject(error);
    }
  }

  async send(method: string, params: unknown[] = []): Promise<unknown> {
    if (!this.ws || !this.isConnected) {
      if (this.messageQueue.length >= this.messageQueueLimit) {
        throw new Error("WebSocket message queue is full");
      }

      return new Promise((resolve, reject) => {
        this.messageQueue.push({ method, params, resolve, reject });
      });
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
    this.subscriptions.set(subId, { event, callback });
    return subId;
  }

  async unsubscribe(subscriptionId: string): Promise<boolean> {
    this.subscriptions.delete(subscriptionId);
    if (!this.ws || !this.isConnected) {
      return true;
    }
    return (await this.send("eth_unsubscribe", [subscriptionId])) as boolean;
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.isConnected = false;
    this.pendingRequests.clear();
  }
}
