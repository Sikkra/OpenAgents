import assert from "node:assert/strict";
import { RetryHandler } from "./retry";

type RetryHandlerInternals = {
  calculateBackoff(attempt: number): number;
};

async function testDefaultMaxRetries(): Promise<void> {
  const handler = new RetryHandler({ baseDelayMs: 0 });
  let attempts = 0;

  await assert.rejects(
    handler.execute(async () => {
      attempts++;
      throw new Error("ETIMEDOUT");
    }),
    /ETIMEDOUT/
  );

  assert.equal(attempts, 6, "default maxRetries should allow 5 retries");
}

async function testSuccessResetsFailureCount(): Promise<void> {
  const handler = new RetryHandler({ baseDelayMs: 0, maxRetries: 2 });
  let attempts = 0;

  const result = await handler.execute(async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error("ECONNRESET");
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(handler.getFailureCount(), 0);
}

function testBackoffCapIsAbsolute(): void {
  const handler = new RetryHandler({
    baseDelayMs: 60_000,
    maxDelayMs: 1_000_000,
  }) as unknown as RetryHandlerInternals;

  assert.equal(handler.calculateBackoff(1000), 60_000);
}

function testJitterRange(): void {
  const originalRandom = Math.random;
  const handler = new RetryHandler({
    baseDelayMs: 100,
    maxDelayMs: 10_000,
  }) as unknown as RetryHandlerInternals;

  try {
    Math.random = () => 0;
    assert.equal(handler.calculateBackoff(1), 200);

    Math.random = () => 1;
    assert.equal(handler.calculateBackoff(1), 250);
  } finally {
    Math.random = originalRandom;
  }
}

async function main(): Promise<void> {
  await testDefaultMaxRetries();
  await testSuccessResetsFailureCount();
  testBackoffCapIsAbsolute();
  testJitterRange();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
