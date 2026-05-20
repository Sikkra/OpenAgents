const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function findImports(importPath) {
  for (const candidate of [
    path.join(root, importPath),
    path.join(root, "contracts", importPath),
    path.join(root, "contracts", importPath.replace(/^\.\.\//, "")),
    path.join(root, "node_modules", importPath),
  ]) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `File not found: ${importPath}` };
}

function compile(file, contractName) {
  const input = {
    language: "Solidity",
    sources: {
      [file]: { content: read(file) },
    },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi"],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (output.errors || []).filter((error) => error.severity === "error");
  assert.strictEqual(errors.length, 0, errors.map((error) => error.formattedMessage).join("\n"));
  return output.contracts[file][contractName].abi;
}

function abiEntry(abi, type, name) {
  const entry = abi.find((candidate) => candidate.type === type && candidate.name === name);
  assert(entry, `${type} ${name} missing from ABI`);
  return entry;
}

const source = read("contracts/vault/YieldAggregator.sol");
const abi = compile("contracts/vault/YieldAggregator.sol", "YieldAggregator");

abiEntry(abi, "function", "addStrategy");
abiEntry(abi, "function", "setStrategyMaxAllocation");
abiEntry(abi, "function", "rebalance");
abiEntry(abi, "function", "strategyAllocationBps");
abiEntry(abi, "event", "StrategyAllocationCapUpdated");

assert(source.includes("maxAllocationBps"), "strategies should track max allocation bps");
assert(source.includes("BPS = 10_000"), "allocation caps should use basis points");
assert(
  source.includes('require(_withinStrategyCap(s, amount), "Vault: allocation cap exceeded")'),
  "manual allocation should enforce strategy caps"
);
assert(
  source.includes("uint256 maxAllocation = (assets * s.maxAllocationBps) / BPS"),
  "rebalance should calculate each strategy cap from total assets"
);
assert(
  source.includes("asset.safeTransfer(s.target, amount);"),
  "rebalance and allocation should move assets to strategy targets"
);
assert(
  source.includes("(strategies[strategyId].allocated * BPS) / assets"),
  "current allocation should be exposed in basis points"
);
assert(
  source.includes("target != address(0)"),
  "strategy targets should reject the zero address"
);

console.log("YieldAggregator allocation cap checks passed");
