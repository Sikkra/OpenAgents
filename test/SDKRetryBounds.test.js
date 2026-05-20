const { expect } = require("chai");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    target: "es2020",
    ignoreDeprecations: "6.0",
  },
});

const { RetryHandler, withRetry } = require("../sdk/src/utils/retry");

describe("SDK retry bounds", function () {
  it("uses five retries by default instead of retrying forever", async function () {
    let attempts = 0;

    try {
      await withRetry(async () => {
        attempts++;
        throw new Error("ETIMEDOUT");
      }, { baseDelayMs: 0 });
      throw new Error("expected retry failure");
    } catch (error) {
      expect(error.message).to.equal("ETIMEDOUT");
    }

    expect(attempts).to.equal(6);
  });

  it("resets consecutive failure count after a successful retry", async function () {
    const handler = new RetryHandler({ baseDelayMs: 0 });
    let attempts = 0;

    const result = await handler.execute(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("ECONNRESET");
      }
      return "ok";
    });

    expect(result).to.equal("ok");
    expect(handler.getFailureCount()).to.equal(0);
  });

  it("caps exponential backoff at 60 seconds even for very large attempts", function () {
    const handler = new RetryHandler({
      baseDelayMs: 1000,
      maxDelayMs: 120000,
    });
    const originalRandom = Math.random;

    Math.random = () => 1;
    try {
      expect(handler.calculateBackoff(2000)).to.equal(60000);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("adds jitter within the accepted 0-25% range", function () {
    const handler = new RetryHandler({
      baseDelayMs: 1000,
      maxDelayMs: 60000,
    });
    const originalRandom = Math.random;

    Math.random = () => 1;
    try {
      const delay = handler.calculateBackoff(1);
      expect(delay).to.be.at.least(2000);
      expect(delay).to.be.at.most(2500);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("normalizes invalid retry options back to safe bounded values", async function () {
    const handler = new RetryHandler({
      maxRetries: Infinity,
      baseDelayMs: 0,
      jitterRatio: 10,
    });

    try {
      await handler.execute(async () => {
        throw new Error("429");
      });
      throw new Error("expected retry failure");
    } catch (error) {
      expect(error.message).to.equal("429");
    }

    expect(handler.getFailureCount()).to.equal(6);
  });
});
