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
  };
  vm.runInNewContext(output, sandbox);
  return sandbox.module.exports;
}

async function testDeployContractWithArgsAndConfirmations() {
  const calls = {};
  const fakeReceipt = { hash: "0xreceipt", gasUsed: 12345n };
  const fakeContract = {
    async waitForDeployment() {
      calls.waitForDeployment = true;
    },
    deploymentTransaction() {
      return {
        hash: "0xdeploy",
        async wait(confirmations) {
          calls.confirmations = confirmations;
          return fakeReceipt;
        },
      };
    },
    async getAddress() {
      return "0x000000000000000000000000000000000000dEaD";
    },
  };

  class FakeContractFactory {
    constructor(abi, bytecode, signer) {
      calls.abi = abi;
      calls.bytecode = bytecode;
      calls.signer = signer;
    }

    async deploy(...args) {
      calls.deployArgs = args;
      return fakeContract;
    }
  }

  const fakeEthers = {
    JsonRpcProvider: class FakeProvider {},
    Wallet: class FakeWallet {
      constructor(privateKey, provider) {
        this.privateKey = privateKey;
        this.provider = provider;
      }
    },
    Contract: class FakeContract {},
    ContractFactory: FakeContractFactory,
  };

  const { OpenAgentsSDK } = loadSdk(fakeEthers);
  const sdk = new OpenAgentsSDK({
    name: "agent",
    endpoint: "https://agent.example",
    privateKey: "0xabc",
    rpcUrl: "http://127.0.0.1:8545",
    registryAddress: "0x0000000000000000000000000000000000000001",
    routerAddress: "0x0000000000000000000000000000000000000002",
  });

  const result = await sdk.deployContract(
    ["constructor(uint256,string)"],
    "0x60006000",
    [42n, "hello"],
    { confirmations: 3, overrides: { value: 10n } }
  );

  assert.deepStrictEqual(calls.abi, ["constructor(uint256,string)"]);
  assert.strictEqual(calls.bytecode, "0x60006000");
  assert.deepStrictEqual(calls.deployArgs, [42n, "hello", { value: 10n }]);
  assert.strictEqual(calls.waitForDeployment, true);
  assert.strictEqual(calls.confirmations, 3);
  assert.strictEqual(result.contract, fakeContract);
  assert.strictEqual(result.address, "0x000000000000000000000000000000000000dEaD");
  assert.strictEqual(result.transactionHash, "0xdeploy");
  assert.strictEqual(result.gasUsed, 12345n);
  assert.strictEqual(result.receipt, fakeReceipt);
}

testDeployContractWithArgsAndConfirmations()
  .then(() => console.log("SDK deploy helper tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
