const { expect } = require("chai");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "CommonJS",
    moduleResolution: "node",
    ignoreDeprecations: "6.0",
  },
});

const { isRetryable, withRetry } = require("../sdk/src/utils/retry.ts");

function statusError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

describe("SDK retry conditional policy", function () {
  it("retries 5xx errors and calls onRetry", async function () {
    let attempts = 0;
    const retryAttempts = [];

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw statusError(500);
        }
        return "ok";
      },
      {
        maxRetries: 3,
        baseDelayMs: 1,
        onRetry: (attempt, error) => retryAttempts.push([attempt, error.status]),
        sleepFn: async () => {},
      }
    );

    expect(result).to.equal("ok");
    expect(attempts).to.equal(3);
    expect(retryAttempts).to.deep.equal([[1, 500], [2, 500]]);
  });

  it("does not retry 4xx errors by default", async function () {
    let attempts = 0;

    try {
      await withRetry(
        async () => {
          attempts++;
          throw statusError(400);
        },
        { maxRetries: 3, sleepFn: async () => {} }
      );
      throw new Error("expected retry failure");
    } catch (error) {
      expect(error.status).to.equal(400);
    }

    expect(attempts).to.equal(1);
    expect(isRetryable(statusError(400))).to.equal(false);
  });

  it("allows custom retry conditions to override defaults", async function () {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw statusError(400);
        }
        return "custom-ok";
      },
      {
        maxRetries: 1,
        retryCondition: (error) => error.status === 400,
        sleepFn: async () => {},
      }
    );

    expect(result).to.equal("custom-ok");
    expect(attempts).to.equal(2);
  });

  it("applies per-error backoff multipliers", async function () {
    const sleeps = [];

    try {
      await withRetry(
        async () => {
          throw statusError(503);
        },
        {
          maxRetries: 1,
          baseDelayMs: 10,
          backoffMultipliers: { "503": 3 },
          sleepFn: async (ms) => sleeps.push(ms),
        }
      );
      throw new Error("expected retry failure");
    } catch (error) {
      expect(error.status).to.equal(503);
    }

    expect(sleeps).to.have.length(1);
    expect(sleeps[0]).to.be.at.least(30);
    expect(sleeps[0]).to.be.below(60);
  });
});
