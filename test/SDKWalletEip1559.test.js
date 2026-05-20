process.env.TS_NODE_TRANSPILE_ONLY = "1";
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
  target: "es2020",
  ignoreDeprecations: "6.0",
});

require("ts-node/register");

const assert = require("assert");
const {
  Wallet: EthersWallet,
  Transaction: EthersTransaction,
  keccak256,
} = require("ethers");
const { Wallet } = require("../sdk/src/auth/wallet");

const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945381ff69c7d4b1522bda39a80a3b1d0200f0";
const TO = "0x1000000000000000000000000000000000000001";

class MockProvider {
  constructor(chainId = 11155111) {
    this.chainId = chainId;
    this.calls = [];
  }

  getChainId() {
    return this.chainId;
  }

  async call(method, params = []) {
    this.calls.push({ method, params });
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method === "eth_maxPriorityFeePerGas") return "0x77359400";
    if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00" };
    throw new Error(`unexpected RPC call: ${method}`);
  }

  async getBalance() {
    return 0n;
  }
}

describe("Wallet EIP-1559 signing", () => {
  it("signs type-2 EIP-1559 transactions to the same raw bytes as ethers", async () => {
    const provider = new MockProvider();
    const wallet = new Wallet({ privateKey: PRIVATE_KEY, provider });
    const tx = {
      to: TO,
      value: 123n,
      data: "0x1234",
      gasLimit: 21000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      nonce: 7,
      chainId: 11155111,
    };

    const signed = await wallet.signTransaction(tx);
    const expectedRaw = await new EthersWallet(PRIVATE_KEY).signTransaction({
      ...tx,
      type: 2,
      accessList: [],
    });

    assert.strictEqual(signed.raw, expectedRaw);
    assert.strictEqual(signed.hash, keccak256(expectedRaw));
    assert.strictEqual(EthersTransaction.from(signed.raw).type, 2);
  });

  it("keeps legacy signing when gasPrice is explicitly provided", async () => {
    const provider = new MockProvider(1);
    const wallet = new Wallet({ privateKey: PRIVATE_KEY.slice(2), provider });
    const tx = {
      to: TO,
      value: 456n,
      data: "0x",
      gasLimit: 22000n,
      gasPrice: 1_500_000_000n,
      nonce: 3,
      chainId: 1,
    };

    const signed = await wallet.signTransaction(tx);
    const expectedRaw = await new EthersWallet(PRIVATE_KEY).signTransaction({
      ...tx,
      type: 0,
    });

    assert.strictEqual(signed.raw, expectedRaw);
    assert.strictEqual(signed.hash, keccak256(expectedRaw));
    assert.strictEqual(EthersTransaction.from(signed.raw).type, 0);
  });

  it("auto-detects type 2 and resolves missing EIP-1559 fees from RPC", async () => {
    const provider = new MockProvider();
    const wallet = new Wallet({ privateKey: PRIVATE_KEY, provider });
    const signed = await wallet.signTransaction({
      to: TO,
      value: 0n,
      data: "0x",
      gasLimit: 21000n,
      nonce: 7,
      chainId: 11155111,
    });
    const tx = EthersTransaction.from(signed.raw);

    assert.strictEqual(tx.type, 2);
    assert.strictEqual(tx.maxPriorityFeePerGas, 2_000_000_000n);
    assert.strictEqual(tx.maxFeePerGas, 4_000_000_000n);
  });

  it("rejects mixed legacy and EIP-1559 fee fields", async () => {
    const provider = new MockProvider();
    const wallet = new Wallet({ privateKey: PRIVATE_KEY, provider });

    await assert.rejects(
      () => wallet.signTransaction({
        to: TO,
        value: 0n,
        data: "0x",
        gasLimit: 21000n,
        gasPrice: 1n,
        maxFeePerGas: 2n,
        nonce: 1,
        chainId: 11155111,
      }),
      /gasPrice cannot be mixed/
    );
  });
});
