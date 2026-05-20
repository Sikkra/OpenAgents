const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");
const contractPath = "contracts/dex/AMMPool.sol";
const source = fs.readFileSync(path.join(root, contractPath), "utf8");

const input = {
  language: "Solidity",
  sources: {
    [contractPath]: { content: source },
  },
  settings: {
    outputSelection: {
      "*": {
        "*": ["abi"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((error) => error.severity === "error");
assert.strictEqual(errors.length, 0, errors.map((error) => error.formattedMessage).join("\n"));

const abi = output.contracts[contractPath].AMMPool.abi;

function eventAbi(name) {
  const event = abi.find((entry) => entry.type === "event" && entry.name === name);
  assert(event, `${name} event missing`);
  return event;
}

function eventInput(event, name) {
  const entry = event.inputs.find((candidate) => candidate.name === name);
  assert(entry, `${event.name}.${name} missing`);
  return entry;
}

const swap = eventAbi("Swap");
assert.strictEqual(eventInput(swap, "user").indexed, true, "Swap.user must be indexed");
assert.strictEqual(eventInput(swap, "tokenIn").indexed, true, "Swap.tokenIn must be indexed");
assert.deepStrictEqual(
  swap.inputs.map((entry) => entry.name),
  ["user", "tokenIn", "amountIn", "amountOut"],
  "Swap event should keep the existing indexer-friendly payload"
);

const mint = eventAbi("Mint");
assert.strictEqual(eventInput(mint, "sender").indexed, true, "Mint.sender must be indexed");
assert.deepStrictEqual(
  mint.inputs.map((entry) => entry.name),
  ["sender", "amount0", "amount1"],
  "Mint event should expose provider and token amounts"
);

const burn = eventAbi("Burn");
assert.strictEqual(eventInput(burn, "sender").indexed, true, "Burn.sender must be indexed");
assert.strictEqual(eventInput(burn, "to").indexed, true, "Burn.to must be indexed");
assert.deepStrictEqual(
  burn.inputs.map((entry) => entry.name),
  ["sender", "amount0", "amount1", "to"],
  "Burn event should expose provider, token amounts, and recipient"
);

const sync = eventAbi("Sync");
assert.deepStrictEqual(
  sync.inputs.map((entry) => entry.name),
  ["reserve0", "reserve1"],
  "Sync event should expose both reserves"
);
assert.deepStrictEqual(
  sync.inputs.map((entry) => entry.type),
  ["uint112", "uint112"],
  "Sync event should use Uniswap V2 reserve widths"
);

const addLiquidityBody = source.slice(
  source.indexOf("function addLiquidity"),
  source.indexOf("function removeLiquidity")
);
assert(addLiquidityBody.includes("emit Mint(msg.sender, amountA, amountB);"), "addLiquidity must emit Mint");
assert(addLiquidityBody.includes("_emitSync();"), "addLiquidity must emit Sync");

const removeLiquidityBody = source.slice(
  source.indexOf("function removeLiquidity"),
  source.indexOf("function swap")
);
assert(removeLiquidityBody.includes("emit Burn(msg.sender, amountA, amountB, msg.sender);"), "removeLiquidity must emit Burn");
assert(removeLiquidityBody.includes("_emitSync();"), "removeLiquidity must emit Sync");

const swapBody = source.slice(source.indexOf("function swap"), source.indexOf("function _emitSync"));
assert(swapBody.includes("emit Swap(msg.sender, tokenIn, amountIn, amountOut);"), "swap must emit Swap");
assert(swapBody.includes("_emitSync();"), "swap must emit Sync after reserves update");
assert(
  swapBody.indexOf("emit Swap(msg.sender, tokenIn, amountIn, amountOut);") <
    swapBody.lastIndexOf("_emitSync();"),
  "swap must emit Sync after Swap"
);

const syncHelperBody = source.slice(source.indexOf("function _emitSync"), source.indexOf("function _sqrt"));
assert(syncHelperBody.includes("type(uint112).max"), "Sync helper must guard uint112 reserve casts");
assert(
  syncHelperBody.includes("emit Sync(uint112(reserveA), uint112(reserveB));"),
  "Sync helper must emit current reserves"
);

console.log("AMMPool event ABI and emission checks passed");
