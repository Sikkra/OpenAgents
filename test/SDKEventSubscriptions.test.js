const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const vm = require("vm");

function loadSdk(fakeEthers) {
  const sourcePath = path.join(__dirname, "..", "sdk", "src", "index.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require(name) {
      if (name === "ethers") {
        return { ethers: fakeEthers };
      }
      return require(name);
    },
    setTimeout,
  };
  vm.runInNewContext(output, sandbox);
  return sandbox.module.exports;
}

function createFakeContract() {
  const calls = { on: [], off: [], filters: [] };
  const websocketHandlers = {};
  const eventFragment = {
    inputs: [
      { name: "user", indexed: true },
      { name: "taskId", indexed: true },
      { name: "status", indexed: false },
    ],
  };
  const filter = { eventName: "TaskUpdated" };
  const contract = {
    interface: {
      getEvent(name) {
        assert.strictEqual(name, "TaskUpdated");
        return eventFragment;
      },
      parseLog(log) {
        assert.deepStrictEqual(log.topics, ["0xtopic"]);
        return {
          args: [
            "0x0000000000000000000000000000000000000003",
            7n,
            "completed",
          ],
        };
      },
    },
    filters: {
      TaskUpdated(...args) {
        calls.filters.push(args);
        return filter;
      },
    },
    runner: {
      provider: {
        websocket: {
          on(eventName, handler) {
            websocketHandlers[eventName] = handler;
          },
          off(eventName, handler) {
            if (websocketHandlers[eventName] === handler) {
              delete websocketHandlers[eventName];
            }
          },
        },
      },
    },
    async on(usedFilter, listener) {
      calls.on.push({ filter: usedFilter, listener });
      contract.listener = listener;
    },
    off(usedFilter, listener) {
      calls.off.push({ filter: usedFilter, listener });
    },
    emitClose() {
      return websocketHandlers.close();
    },
    hasCloseHandler() {
      return Boolean(websocketHandlers.close);
    },
  };
  return { contract, calls, filter };
}

async function testSubscribeDecodeFilterAndReconnect() {
  const fakeEthers = {
    JsonRpcProvider: class FakeProvider {},
    Wallet: class FakeWallet {},
    Contract: class FakeContract {},
    toUtf8Bytes(value) {
      return Buffer.from(value, "utf8");
    },
  };
  const { OpenAgentsSDK } = loadSdk(fakeEthers);
  const sdk = new OpenAgentsSDK({
    name: "agent",
    endpoint: "https://agent.example",
    privateKey: "0xabc",
    rpcUrl: "ws://127.0.0.1:8545",
    registryAddress: "0x0000000000000000000000000000000000000001",
    routerAddress: "0x0000000000000000000000000000000000000002",
  });
  const { contract, calls, filter } = createFakeContract();
  const received = [];

  const subscription = sdk.subscribeToEvents(
    contract,
    "TaskUpdated",
    (event) => received.push(event),
    {
      indexedFilters: {
        user: "0x0000000000000000000000000000000000000003",
        taskId: 7n,
      },
      reconnectDelayMs: 0,
    }
  );

  assert.deepStrictEqual(calls.filters, [["0x0000000000000000000000000000000000000003", 7n]]);
  assert.strictEqual(calls.on.length, 1);
  assert.strictEqual(calls.on[0].filter, filter);

  await contract.listener(
    "0x0000000000000000000000000000000000000003",
    7n,
    "completed",
    { log: { transactionHash: "0xabc" } }
  );

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].name, "TaskUpdated");
  assert.strictEqual(received[0].args.user, "0x0000000000000000000000000000000000000003");
  assert.strictEqual(received[0].args.taskId, 7n);
  assert.strictEqual(received[0].args.status, "completed");
  assert.strictEqual(received[0].log.transactionHash, "0xabc");

  await contract.emitClose();
  assert.strictEqual(calls.off.length, 1);
  assert.strictEqual(calls.on.length, 2);

  await contract.listener({ topics: ["0xtopic"], data: "0xdata" });
  assert.strictEqual(received.length, 2);
  assert.strictEqual(received[1].args.status, "completed");

  subscription.unsubscribe();
  assert.strictEqual(calls.off.length, 2);
  assert.strictEqual(contract.hasCloseHandler(), false);
}

testSubscribeDecodeFilterAndReconnect()
  .then(() => console.log("SDK event subscription tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
