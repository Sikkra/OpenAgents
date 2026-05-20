/**
 * Retry utility with exponential backoff for unreliable RPC calls.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "onRetry">> = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
};
const MAX_RETRIES_CAP = 50;
const MAX_BACKOFF_MS = 60_000;
const MAX_EXPONENT = 30;

export class RetryHandler {
  private options: Required<Omit<RetryOptions, "onRetry">>;
  private onRetry?: (attempt: number, error: Error) => void;
  private consecutiveFailures = 0;

  constructor(options: RetryOptions = {}) {
    this.options = RetryHandler.normalizeOptions(options);
    this.onRetry = options.onRetry;
  }

  private static normalizeOptions(
    options: RetryOptions
  ): Required<Omit<RetryOptions, "onRetry">> {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const requestedRetries = Number.isFinite(merged.maxRetries)
      ? Math.floor(merged.maxRetries)
      : DEFAULT_OPTIONS.maxRetries;

    return {
      maxRetries: Math.min(Math.max(requestedRetries, 0), MAX_RETRIES_CAP),
      baseDelayMs: Math.max(0, Math.floor(merged.baseDelayMs)),
      maxDelayMs: Math.min(
        Math.max(0, Math.floor(merged.maxDelayMs)),
        MAX_BACKOFF_MS
      ),
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        const result = await fn();
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.consecutiveFailures++;

        if (attempt < this.options.maxRetries) {
          this.onRetry?.(attempt + 1, lastError);
          const delay = this.calculateBackoff(attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error("Retry failed with unknown error");
  }

  private calculateBackoff(attempt: number): number {
    const exponent = Math.min(Math.max(attempt, 0), MAX_EXPONENT);
    const exponentialDelay = this.options.baseDelayMs * Math.pow(2, exponent);
    const jitter = Math.random() * this.options.baseDelayMs;
    return Math.min(exponentialDelay + jitter, this.options.maxDelayMs, MAX_BACKOFF_MS);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
  const retryableCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "429"];
  const message = error.message.toLowerCase();
  return retryableCodes.some(
    (code) => message.includes(code.toLowerCase())
  );
}
