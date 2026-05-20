const { expect } = require("chai");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "CommonJS",
    moduleResolution: "node",
    ignoreDeprecations: "6.0",
  },
});

const { OpenAgentsSDK } = require("../sdk/src/index.ts");

function sdkWith(router, provider) {
  return new OpenAgentsSDK({
    name: "agent",
    endpoint: "https://agent.example",
    privateKey: "0x" + "1".repeat(64),
    rpcUrl: "http://localhost:8545",
    registryAddress: "0x" + "2".repeat(40),
    routerAddress: "0x" + "3".repeat(40),
    provider,
    signer: {},
    contractFactory: () => router,
  });
}

function task(id, status = 0) {
  return [
    "0x" + String(id % 10).repeat(40),
    "0x" + "0".repeat(64),
    `task-${id}`,
    BigInt(id + 1),
    BigInt(1000 + id),
    status,
    "0x",
  ];
}

describe("OpenAgentsSDK getOpenTasks", function () {
  it("paginates and fetches tasks concurrently in batches of ten", async function () {
    let active = 0;
    let maxActive = 0;
    const fetched = [];
    const router = {
      taskCount: async () => 30n,
      tasks: async (id) => {
        fetched.push(id);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return task(id, 0);
      },
    };
    const provider = { getBlockNumber: async () => 7 };
    const sdk = sdkWith(router, provider);

    const result = await sdk.getOpenTasks({ offset: 5, limit: 12 });

    expect(result.map((entry) => entry.id)).to.deep.equal([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(fetched).to.deep.equal([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(maxActive).to.equal(10);
  });

  it("filters by requested status", async function () {
    const router = {
      taskCount: async () => 5n,
      tasks: async (id) => task(id, id % 2),
    };
    const provider = { getBlockNumber: async () => 8 };
    const sdk = sdkWith(router, provider);

    const closed = await sdk.getOpenTasks({ limit: 5, status: 1 });
    const all = await sdk.getOpenTasks({ limit: 5, status: null });

    expect(closed.map((entry) => entry.id)).to.deep.equal([1, 3]);
    expect(all.map((entry) => entry.id)).to.deep.equal([0, 1, 2, 3, 4]);
  });

  it("caches task count for one block", async function () {
    let blockNumber = 10;
    let countCalls = 0;
    const router = {
      taskCount: async () => {
        countCalls++;
        return 3n;
      },
      tasks: async (id) => task(id, 0),
    };
    const provider = { getBlockNumber: async () => blockNumber };
    const sdk = sdkWith(router, provider);

    await sdk.getOpenTasks({ limit: 2 });
    await sdk.getOpenTasks({ limit: 2 });
    blockNumber = 11;
    await sdk.getOpenTasks({ limit: 2 });

    expect(countCalls).to.equal(2);
  });
});
