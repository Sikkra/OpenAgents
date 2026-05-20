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

const {
  AuthenticationError,
  SessionManager,
} = require("../sdk/src/auth/session");

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createWallet() {
  return {
    address: "0x1234567890123456789012345678901234567890",
    async sendTransaction() {
      return "0xsigned";
    },
  };
}

function createSession(onAuthFailure) {
  return new SessionManager({
    wallet: createWallet(),
    apiBaseUrl: "https://api.openagents.local",
    onAuthFailure,
  });
}

describe("SessionManager authenticated requests", function () {
  let originalFetch;

  beforeEach(function () {
    originalFetch = global.fetch;
  });

  afterEach(function () {
    global.fetch = originalFetch;
  });

  it("refreshes on a 401 and retries the original request once", async function () {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse(200, {
          token: "old-token",
          refreshToken: "refresh-token",
          expiresAt: futureExpiry,
          walletAddress: createWallet().address,
        });
      }
      if (calls.length === 2) {
        return jsonResponse(401, { error: "expired" });
      }
      if (calls.length === 3) {
        return jsonResponse(200, {
          token: "new-token",
          refreshToken: "new-refresh-token",
          expiresAt: futureExpiry,
          walletAddress: createWallet().address,
        });
      }
      return jsonResponse(200, { ok: true });
    };

    const session = createSession();
    const response = await session.request("https://api.openagents.local/v1/me");

    expect(response.status).to.equal(200);
    expect(calls).to.have.length(4);
    expect(calls[1].init.headers.get("Authorization")).to.equal(
      "Bearer old-token"
    );
    expect(calls[3].init.headers.get("Authorization")).to.equal(
      "Bearer new-token"
    );
  });

  it("throws AuthenticationError when the retry also returns 401", async function () {
    const calls = [];
    let failures = 0;
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse(200, {
          token: "old-token",
          refreshToken: "refresh-token",
          expiresAt: futureExpiry,
          walletAddress: createWallet().address,
        });
      }
      if (calls.length === 2) {
        return jsonResponse(401, { error: "expired" });
      }
      if (calls.length === 3) {
        return jsonResponse(200, {
          token: "new-token",
          refreshToken: "new-refresh-token",
          expiresAt: futureExpiry,
          walletAddress: createWallet().address,
        });
      }
      return jsonResponse(401, { error: "still unauthorized" });
    };

    const session = createSession(() => {
      failures++;
    });

    try {
      await session.request("https://api.openagents.local/v1/me");
      throw new Error("expected auth failure");
    } catch (error) {
      expect(error).to.be.instanceOf(AuthenticationError);
      expect(error.message).to.equal(
        "Authentication failed after token refresh retry"
      );
    }

    expect(calls).to.have.length(4);
    expect(failures).to.equal(1);
  });

  it("fires onAuthFailure when refresh fails after the first 401", async function () {
    const failures = [];
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse(200, {
          token: "old-token",
          refreshToken: "refresh-token",
          expiresAt: futureExpiry,
          walletAddress: createWallet().address,
        });
      }
      if (calls.length === 2) {
        return jsonResponse(401, { error: "expired" });
      }
      return jsonResponse(500, { error: "refresh failed" });
    };

    const session = createSession((error) => {
      failures.push(error.message);
    });

    try {
      await session.fetch("https://api.openagents.local/v1/me");
      throw new Error("expected auth failure");
    } catch (error) {
      expect(error).to.be.instanceOf(AuthenticationError);
      expect(error.message).to.equal("Token refresh failed after 401");
    }

    expect(calls).to.have.length(3);
    expect(failures).to.deep.equal(["Token refresh failed after 401"]);
  });
});
