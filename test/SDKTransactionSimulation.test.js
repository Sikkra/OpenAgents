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
  TransactionSimulationError,
  Wallet,
} = require("../sdk/src/auth/wallet");

const PRIVATE_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

function encodeRevertReason(reason) {
  const reasonHex = Buffer.from(reason, "utf8").toString("hex");
  const length = reasonHex.length / 2;
  const paddedReason = reasonHex.padEnd(Math.ceil(reasonHex.length / 64) * 64, "0");
  return (
    "0x08c379a0" +
    "20".padStart(64, "0") +
    length.toString(16).padStart(64, "0") +
    paddedReason
  );
}

function createProvider(handler) {
  const calls = [];
  let blockNumber = 1;
  return {
    calls,
    setBlockNumber(nextBlock) {
      blockNumber = nextBlock;
    },
    async getBlockNumber() {
      calls.push({ method: "eth_blockNumber", params: [] });
      return blockNumber;
    },
    async call(method, params = []) {
      calls.push({ method, params });
      return handler(method, params);
    },
    async getBalance() {
      return 0n;
    },
  };
}

function createWallet(provider) {
  return new Wallet({
    privateKey: PRIVATE_KEY,
    provider,
  });
}

const tx = {
  to: "0x0000000000000000000000000000000000000002",
  value: 1n,
  data: "0xabcdef",
  gasLimit: 21000n,
  gasPrice: 1n,
  nonce: 0,
};

describe("Wallet transaction simulation", function () {
  it("simulates via eth_call before sending", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_sendRawTransaction") return "0xsent";
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    expect(await wallet.sendTransaction(tx)).to.equal("0xsent");
    expect(provider.calls.map((call) => call.method)).to.deep.equal([
      "eth_blockNumber",
      "eth_call",
      "eth_sendRawTransaction",
    ]);
  });

  it("decodes revert reasons and blocks send", async function () {
    const revertData = encodeRevertReason("insufficient stake");
    const provider = createProvider((method) => {
      if (method === "eth_call") {
        const error = new Error(`execution reverted: ${revertData}`);
        error.data = revertData;
        throw error;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    try {
      await wallet.sendTransaction(tx);
      throw new Error("expected simulation failure");
    } catch (error) {
      expect(error).to.be.instanceOf(TransactionSimulationError);
      expect(error.reason).to.equal("insufficient stake");
      expect(error.revertData).to.equal(revertData);
    }

    expect(provider.calls.map((call) => call.method)).not.to.include(
      "eth_sendRawTransaction"
    );
  });

  it("caches successful simulations for the same transaction within a block", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_sendRawTransaction") return "0xsent";
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    await wallet.sendTransaction(tx);
    await wallet.sendTransaction(tx);

    expect(provider.calls.filter((call) => call.method === "eth_call")).to.have.length(1);
    expect(provider.calls.filter((call) => call.method === "eth_sendRawTransaction")).to.have.length(2);
  });

  it("invalidates the simulation cache on a new block", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_sendRawTransaction") return "0xsent";
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    await wallet.sendTransaction(tx);
    provider.setBlockNumber(2);
    await wallet.sendTransaction(tx);

    expect(provider.calls.filter((call) => call.method === "eth_call")).to.have.length(2);
  });

  it("supports an explicit skipSimulation option", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_sendRawTransaction") return "0xsent";
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    expect(await wallet.sendTransaction({ ...tx, skipSimulation: true })).to.equal("0xsent");
    expect(provider.calls.map((call) => call.method)).to.deep.equal([
      "eth_sendRawTransaction",
    ]);
  });
});
