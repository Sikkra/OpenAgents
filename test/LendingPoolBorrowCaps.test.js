const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
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
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((error) => error.severity === "error");
  assert.strictEqual(errors.length, 0, errors.map((error) => error.formattedMessage).join("\n"));
  return output.contracts[file][contractName].abi;
}

function abiEntry(abi, type, name) {
  const entry = abi.find((candidate) => candidate.type === type && candidate.name === name);
  assert(entry, `${type} ${name} missing from ABI`);
  return entry;
}

const source = read("contracts/lending/LendingPool.sol");
const abi = compile("contracts/lending/LendingPool.sol", "LendingPool");

abiEntry(abi, "function", "owner");
abiEntry(abi, "function", "maxBorrowPerAsset");
abiEntry(abi, "function", "setMaxBorrowPerAsset");
abiEntry(abi, "function", "MAX_USER_BORROW_BPS");
abiEntry(abi, "function", "MAX_UTILIZATION_BPS");
abiEntry(abi, "event", "MaxBorrowPerAssetUpdated");

assert(source.includes("MAX_USER_BORROW_BPS = 2_500"), "single user cap should be 25% of the pool");
assert(source.includes("MAX_UTILIZATION_BPS = 9_500"), "utilization cap should be 95%");
assert(source.includes("modifier onlyOwner()"), "borrow caps should be owner configurable");
assert(source.includes("maxBorrowPerAsset[asset] = maxBorrow"), "owner should configure per-asset caps");
assert(
  source.includes('require(newTotalBorrowed <= assetCap, "Asset cap exceeded")'),
  "borrows above the per-asset cap should revert"
);
assert(
  source.includes('require(newUserDebt <= (poolSize * MAX_USER_BORROW_BPS) / BPS, "User cap exceeded")'),
  "single users should not exceed 25% of the pool"
);
assert(
  source.includes('require(newTotalBorrowed <= (poolSize * MAX_UTILIZATION_BPS) / BPS, "Utilization too high")'),
  "new borrows should not push utilization above 95%"
);
assert(
  source.indexOf("_validateBorrowCaps(msg.sender, amount)") < source.indexOf("positions[msg.sender].borrowedAmount += amount"),
  "borrow caps should be checked before debt is recorded"
);

console.log("LendingPool borrow cap checks passed");
