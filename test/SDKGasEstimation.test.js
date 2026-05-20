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

const { Wallet } = require("../sdk/src/auth/wallet");

const PRIVATE_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

function createProvider(resolver) {
  const calls = [];
  return {
    calls,
    async call(method, params = []) {
      calls.push({ method, params });
      return resolver(method, params, calls.length);
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

const baseTx = {
  to: "0x0000000000000000000000000000000000000002",
  value: 1n,
  data: "0x",
};

describe("Wallet gas estimation", function () {
  it("adds a default 20% margin to eth_estimateGas", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_getBlockByNumber") {
        return { gasLimit: "0x100000", baseFeePerGas: "0x3b9aca00" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    expect(await wallet.estimateGasLimit(baseTx)).to.equal(25200n);
  });

  it("caps estimated gas at the latest block gas limit", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_estimateGas") return "0x186a0";
      if (method === "eth_getBlockByNumber") {
        return { gasLimit: "0x1adb0", baseFeePerGas: "0x3b9aca00" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    expect(await wallet.estimateGasLimit(baseTx)).to.equal(110000n);
  });

  it("uses EIP-1559 fee data when the latest block has a base fee", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_getBlockByNumber") {
        return { gasLimit: "0x100000", baseFeePerGas: "0x3b9aca00" };
      }
      if (method === "eth_maxPriorityFeePerGas") return "0x77359400";
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    await wallet.signTransaction(baseTx);

    expect(provider.calls.map((call) => call.method)).to.include(
      "eth_maxPriorityFeePerGas"
    );
    expect(provider.calls.map((call) => call.method)).not.to.include(
      "eth_gasPrice"
    );
  });

  it("falls back to legacy gas price when the latest block has no base fee", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_getBlockByNumber") return { gasLimit: "0x100000" };
      if (method === "eth_gasPrice") return "0x3b9aca00";
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    await wallet.signTransaction(baseTx);

    expect(provider.calls.map((call) => call.method)).to.include(
      "eth_gasPrice"
    );
  });

  it("honors manual gas and fee overrides without calling eth_estimateGas", async function () {
    const provider = createProvider((method) => {
      if (method === "eth_getTransactionCount") return "0x0";
      throw new Error(`unexpected method ${method}`);
    });
    const wallet = createWallet(provider);

    await wallet.signTransaction({
      ...baseTx,
      gasLimit: 50000n,
      gasPrice: 10n,
    });

    expect(provider.calls.map((call) => call.method)).to.deep.equal([
      "eth_getTransactionCount",
    ]);
  });
});
