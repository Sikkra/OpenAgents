const { expect } = require("chai");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "CommonJS",
    moduleResolution: "node",
    ignoreDeprecations: "6.0",
  },
});

const { SessionManager } = require("../sdk/src/auth/session.ts");

function token(name, expiresOffsetSeconds, refreshToken = `${name}-refresh`) {
  return {
    token: name,
    expiresAt: Math.floor(Date.now() / 1000) + expiresOffsetSeconds,
    refreshToken,
    walletAddress: "0x1111111111111111111111111111111111111111",
  };
}

function wallet() {
  return {
    address: "0x1111111111111111111111111111111111111111",
    sendTransaction: async () => "0xsigned",
  };
}

describe("SDK SessionManager token lifecycle", function () {
  const originalFetch = global.fetch;
  const originalWindow = global.window;

  afterEach(function () {
    global.fetch = originalFetch;
    global.window = originalWindow;
  });

  it("authenticates without reading or writing localStorage", async function () {
    global.window = {
      localStorage: {
        getItem: () => {
          throw new Error("localStorage getItem must not be used");
        },
        setItem: () => {
          throw new Error("localStorage setItem must not be used");
        },
      },
    };
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => token("login-token", 3600, "login-refresh"),
    });

    const manager = new SessionManager({
      wallet: wallet(),
      apiBaseUrl: "https://api.example",
    });

    expect(await manager.getToken()).to.equal("login-token");
    expect(manager.isAuthenticated()).to.equal(true);
  });

  it("auto-refreshes expired tokens and coalesces concurrent refreshes", async function () {
    let refreshCalls = 0;
    global.fetch = async () => {
      refreshCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => token("fresh-token", 3600, "fresh-refresh"),
      };
    };

    const manager = new SessionManager({
      wallet: wallet(),
      apiBaseUrl: "https://api.example",
    });
    manager.currentToken = token("expired-token", -60, "old-refresh");

    const results = await Promise.all([
      manager.getToken(),
      manager.getToken(),
      manager.refresh().then((session) => session.token),
    ]);

    expect(results).to.deep.equal(["fresh-token", "fresh-token", "fresh-token"]);
    expect(refreshCalls).to.equal(1);
    expect(manager.currentToken.refreshToken).to.equal("fresh-refresh");
  });

  it("rotates refresh tokens across refresh calls", async function () {
    const seenRefreshTokens = [];
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      seenRefreshTokens.push(body.refreshToken);
      const next = seenRefreshTokens.length;
      return {
        ok: true,
        status: 200,
        json: async () => token(`token-${next}`, 3600, `refresh-${next}`),
      };
    };

    const manager = new SessionManager({
      wallet: wallet(),
      apiBaseUrl: "https://api.example",
    });
    manager.currentToken = token("expired-token", -60, "refresh-0");

    expect((await manager.refresh()).token).to.equal("token-1");
    expect((await manager.refresh()).token).to.equal("token-2");
    expect(seenRefreshTokens).to.deep.equal(["refresh-0", "refresh-1"]);
  });
});
