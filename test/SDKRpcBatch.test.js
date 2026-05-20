const { expect } = require("chai");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "CommonJS",
    moduleResolution: "node",
    ignoreDeprecations: "6.0",
  },
});

const {
  JsonRpcBatchItemError,
  RpcProvider,
} = require("../sdk/src/providers/rpc.ts");

describe("SDK RPC batch calls", function () {
  const originalFetch = global.fetch;

  afterEach(function () {
    global.fetch = originalFetch;
  });

  it("matches shuffled batch responses by JSON-RPC id", async function () {
    global.fetch = async (_url, options) => {
      const requests = JSON.parse(options.body);

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          { jsonrpc: "2.0", id: requests[2].id, result: "third" },
          { jsonrpc: "2.0", id: requests[0].id, result: "first" },
          { jsonrpc: "2.0", id: requests[1].id, result: "second" },
        ],
      };
    };

    const provider = new RpcProvider({
      url: "https://rpc.example",
      chainId: 1,
    });

    const results = await provider.batchCall([
      { method: "first", params: [] },
      { method: "second", params: [] },
      { method: "third", params: [] },
    ]);

    expect(results).to.deep.equal(["first", "second", "third"]);
  });

  it("returns per-request errors for partial failures and missing responses", async function () {
    global.fetch = async (_url, options) => {
      const requests = JSON.parse(options.body);

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          { jsonrpc: "2.0", id: requests[0].id, result: "ok" },
          {
            jsonrpc: "2.0",
            id: requests[1].id,
            error: { code: -32001, message: "method failed", data: "details" },
          },
        ],
      };
    };

    const provider = new RpcProvider({
      url: "https://rpc.example",
      chainId: 1,
      requestTimeoutMs: 25,
    });

    const results = await provider.batchCall([
      { method: "succeeds", params: [] },
      { method: "fails", params: [] },
      { method: "timesOut", params: [] },
    ]);

    expect(results[0]).to.equal("ok");
    expect(results[1]).to.be.instanceOf(JsonRpcBatchItemError);
    expect(results[1]).to.include({
      method: "fails",
      code: -32001,
      data: "details",
    });
    expect(results[1].message).to.equal("RPC error -32001: method failed");

    expect(results[2]).to.be.instanceOf(JsonRpcBatchItemError);
    expect(results[2]).to.include({
      method: "timesOut",
      code: -32000,
    });
    expect(results[2].message).to.contain("timed out after 25ms");
  });
});
