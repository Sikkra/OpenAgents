/**
 * @generated-by Codex
 * @timestamp 2026-05-20T06:03:00Z
 * @startup-config private platform/session instructions intentionally omitted
 * @runtime windows/x64, powershell, OpenAgents workspace
 */

/**
 * Retry utility with exponential backoff for unreliable RPC calls.
 */

export type RetryCondition = (error: Error, attempt: number) => boolean;
export type BackoffMultiplier = number | ((error: Error) => number);

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryCondition?: RetryCondition;
  backoffMultipliers?: Record<string, BackoffMultiplier>;
  onRetry?: (attempt: number, error: Error) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

type ResolvedRetryOptions = Required<
  Omit<RetryOptions, "retryCondition" | "backoffMultipliers" | "onRetry" | "sleepFn">
>;

const DEFAULT_OPTIONS: ResolvedRetryOptions = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export class RetryHandler {
  private options: ResolvedRetryOptions;
  private retryCondition: RetryCondition;
  private backoffMultipliers: Record<string, BackoffMultiplier>;
  private onRetry?: (attempt: number, error: Error) => void;
  private sleepFn: (ms: number) => Promise<void>;
  private consecutiveFailures = 0;

  constructor(options: RetryOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.retryCondition = options.retryCondition ?? isRetryable;
    this.backoffMultipliers = options.backoffMultipliers ?? {};
    this.onRetry = options.onRetry;
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        const result = await fn();
        this.reset();
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.consecutiveFailures++;

        const nextAttempt = attempt + 1;
        const shouldRetry =
          attempt < this.options.maxRetries &&
          this.retryCondition(lastError, nextAttempt);

        if (!shouldRetry) {
          break;
        }

        this.onRetry?.(nextAttempt, lastError);
        const delay = this.calculateBackoff(attempt, lastError);
        await this.sleep(delay);
      }
    }

    throw lastError ?? new Error("Retry failed with unknown error");
  }

  private calculateBackoff(attempt: number, error: Error): number {
    const exponent = Math.min(attempt, 30);
    const exponentialDelay = this.options.baseDelayMs * Math.pow(2, exponent);
    const jitter = Math.random() * this.options.baseDelayMs;
    const multiplier = this.getBackoffMultiplier(error);
    return Math.min((exponentialDelay + jitter) * multiplier, this.options.maxDelayMs);
  }

  private getBackoffMultiplier(error: Error): number {
    const keys = getErrorKeys(error);
    for (const key of keys) {
      const multiplier = this.backoffMultipliers[key];
      if (typeof multiplier === "number") {
        return multiplier;
      }
      if (typeof multiplier === "function") {
        return multiplier(error);
      }
    }
    return 1;
  }

  private sleep(ms: number): Promise<void> {
    return this.sleepFn(ms);
  }

  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const handler = new RetryHandler(options);
  return handler.execute(fn);
}

export function isRetryable(error: Error): boolean {
  const status = getHttpStatus(error);
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }

  const retryableCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"];
  const code = getErrorCode(error);
  if (code && retryableCodes.includes(code.toUpperCase())) {
    return true;
  }

  const message = error.message.toLowerCase();
  return ["timeout", "network", "temporarily unavailable"].some((needle) =>
    message.includes(needle)
  );
}

function getHttpStatus(error: Error): number | undefined {
  const candidate = error as Error & {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  if (typeof status === "number") {
    return status;
  }

  const match = error.message.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function getErrorCode(error: Error): string | undefined {
  const candidate = error as Error & { code?: string };
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

function getErrorKeys(error: Error): string[] {
  const keys = [];
  const status = getHttpStatus(error);
  const code = getErrorCode(error);
  if (status !== undefined) keys.push(String(status));
  if (code) keys.push(code, code.toUpperCase());
  keys.push(error.name);
  return keys;
}
