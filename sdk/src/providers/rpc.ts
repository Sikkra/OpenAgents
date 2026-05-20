/**
 * Contributor traceability:
 * Agent: Codex
 * Platform instructions: private runtime/session material intentionally omitted.
 * Runtime: Windows x64, PowerShell, OpenAgents workspace.
 */
import { withRetry, RetryOptions } from "../utils/retry";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpcBatchItemError extends Error {
  readonly requestId: number;
  readonly method: string;
  readonly code?: number;
  readonly data?: unknown;

  constructor(
    request: JsonRpcRequest,
    message: string,
    options: { code?: number; data?: unknown } = {}
  ) {
    super(message);
    this.name = "JsonRpcBatchItemError";
    this.requestId = request.id;
    this.method = request.method;
    this.code = options.code;
    this.data = options.data;
  }
}

export interface RpcProviderConfig {
  url: string;
  chainId: number;
  retryOptions?: RetryOptions;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
}

export interface BatchCallOptions {
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class RpcProvider {
  private url: string;
  private chainId: number;
  private retryOptions: RetryOptions;
  private headers: Record<string, string>;
  private requestTimeoutMs: number;
  private requestId = 0;

  constructor(config: RpcProviderConfig) {
    this.url = config.url;
    this.chainId = config.chainId;
    this.retryOptions = config.retryOptions ?? {};
    this.headers = config.headers ?? {};
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      params,
    };

    return withRetry(async () => {
      const json = await this.postJson<JsonRpcResponse>(
        request,
        this.requestTimeoutMs
      );

      if (json.error) {
        throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
      }

      return json.result;
    }, this.retryOptions);
  }

  async batchCall(
    calls: Array<{ method: string; params: unknown[] }>,
    options: BatchCallOptions = {}
  ): Promise<unknown[]> {
    const requests: JsonRpcRequest[] = calls.map((c) => ({
      jsonrpc: "2.0" as const,
      id: ++this.requestId,
      method: c.method,
      params: c.params,
    }));

    if (requests.length === 0) {
      return [];
    }

    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const responses = await this.postJson<JsonRpcResponse[]>(
      requests,
      timeoutMs
    );

    if (!Array.isArray(responses)) {
      throw new Error("RPC batch response must be an array");
    }

    const requestIds = new Set(requests.map((request) => request.id));
    const responsesById = new Map<number, JsonRpcResponse>();
    for (const response of responses) {
      if (typeof response?.id === "number" && requestIds.has(response.id)) {
        responsesById.set(response.id, response);
      }
    }

    return requests.map((request) => {
      const response = responsesById.get(request.id);
      if (!response) {
        return new JsonRpcBatchItemError(
          request,
          `RPC request ${request.id} (${request.method}) timed out after ${timeoutMs}ms`,
          { code: -32000 }
        );
      }

      if (response.error) {
        return new JsonRpcBatchItemError(
          request,
          `RPC error ${response.error.code}: ${response.error.message}`,
          { code: response.error.code, data: response.error.data }
        );
      }

      return response.result;
    });
  }

  async getBlockNumber(): Promise<number> {
    const hex = (await this.call("eth_blockNumber")) as string;
    return parseInt(hex, 16);
  }

  async getBalance(address: string): Promise<bigint> {
    const hex = (await this.call("eth_getBalance", [address, "latest"])) as string;
    return BigInt(hex);
  }

  getChainId(): number {
    return this.chainId;
  }

  private async postJson<T>(
    payload: JsonRpcRequest | JsonRpcRequest[],
    timeoutMs: number
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`RPC HTTP error ${res.status}: ${res.statusText}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`RPC request timed out after ${timeoutMs}ms`);
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
