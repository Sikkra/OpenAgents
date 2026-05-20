/**
 * @contributor: Codex
 * @timestamp: 2026-05-20T01:37:48.7218402-05:00
 * @platform-config: private platform/session initialization text intentionally omitted
 * @runtime: os=windows, arch=x64, home_dir=C:\Users\Ben, working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents, shell=powershell
 *
 * Retry utility with exponential backoff for unreliable RPC calls.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "onRetry">> = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  jitterRatio: 0.25,
};

const MAX_RETRIES_CAP = 50;
const MAX_BACKOFF_MS = 60_000;
const MAX_EXPONENT = 30;
const MAX_JITTER_RATIO = 0.25;

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

    return {
      maxRetries: RetryHandler.clampInteger(
        merged.maxRetries,
        DEFAULT_OPTIONS.maxRetries,
        0,
        MAX_RETRIES_CAP
      ),
      baseDelayMs: RetryHandler.clampInteger(
        merged.baseDelayMs,
        DEFAULT_OPTIONS.baseDelayMs,
        0,
        Number.MAX_SAFE_INTEGER
      ),
      maxDelayMs: RetryHandler.clampInteger(
        merged.maxDelayMs,
        DEFAULT_OPTIONS.maxDelayMs,
        0,
        MAX_BACKOFF_MS
      ),
      jitterRatio: RetryHandler.clampFiniteNumber(
        merged.jitterRatio,
        DEFAULT_OPTIONS.jitterRatio,
        0,
        MAX_JITTER_RATIO
      ),
    };
  }

  private static clampInteger(
    value: number,
    fallback: number,
    min: number,
    max: number
  ): number {
    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(Math.max(Math.floor(value), min), max);
  }

  private static clampFiniteNumber(
    value: number,
    fallback: number,
    min: number,
    max: number
  ): number {
    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(Math.max(value, min), max);
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
    const normalizedAttempt = RetryHandler.clampInteger(
      attempt,
      0,
      0,
      MAX_EXPONENT
    );
    const exponentialDelay =
      this.options.baseDelayMs * Math.pow(2, normalizedAttempt);
    const cappedBaseDelay = Math.min(
      exponentialDelay,
      this.options.maxDelayMs,
      MAX_BACKOFF_MS
    );
    const jitter = cappedBaseDelay * Math.random() * this.options.jitterRatio;

    return Math.min(cappedBaseDelay + jitter, this.options.maxDelayMs);
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
