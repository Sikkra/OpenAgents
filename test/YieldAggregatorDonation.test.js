const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");
const contractPath = "contracts/vault/YieldAggregator.sol";
const source = fs.readFileSync(path.join(root, contractPath), "utf8");

function findImports(importPath) {
  for (const candidate of [path.join(root, importPath), path.join(root, "node_modules", importPath)]) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `File not found: ${importPath}` };
}

const solcInput = {
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

const output = JSON.parse(solc.compile(JSON.stringify(solcInput), { import: findImports }));
const errors = (output.errors || []).filter((error) => error.severity === "error");
assert.strictEqual(errors.length, 0, errors.map((error) => error.formattedMessage).join("\n"));

const abi = output.contracts[contractPath].YieldAggregator.abi;

function functionsNamed(name) {
  return abi.filter((entry) => entry.type === "function" && entry.name === name);
}

const depositOverloads = functionsNamed("deposit");
assert(depositOverloads.some((entry) => entry.inputs.length === 2), "deposit(amount,minShares) overload missing");
assert(depositOverloads.some((entry) => entry.inputs.length === 1), "deposit(amount) compatibility overload missing");
const guardedDeposit = depositOverloads.find((entry) => entry.inputs.length === 2);
assert.deepStrictEqual(
  guardedDeposit.inputs.map((entry) => entry.name),
  ["amount", "minShares"],
  "deposit overload should expose minShares"
);

for (const name of ["MAX_PRICE_DEVIATION_BPS", "BPS_DENOMINATOR", "isSharePriceSane", "previewDeposit"]) {
  assert(functionsNamed(name).length > 0, `${name} missing from ABI`);
}

function sharesFromInternalAccounting(amount, totalShares, accountedAssets) {
  return totalShares === 0 ? amount : Math.floor((amount * totalShares) / accountedAssets);
}

assert.strictEqual(sharesFromInternalAccounting(100, 100, 100), 100, "fair deposit should mint par shares");
assert.strictEqual(
  sharesFromInternalAccounting(100, 100, 100),
  sharesFromInternalAccounting(100, 100, 100),
  "direct token donations should not affect internal share math"
);

function sane(accountedAssets, observedAssets) {
  const maxAssets = accountedAssets + Math.floor((accountedAssets * 500) / 10000);
  const minAssets = accountedAssets - Math.floor((accountedAssets * 500) / 10000);
  return observedAssets >= minAssets && observedAssets <= maxAssets;
}

assert.strictEqual(sane(1000, 1050), true, "5 percent deviation should be accepted");
assert.strictEqual(sane(1000, 1051), false, "more than 5 percent positive deviation should revert");
assert.strictEqual(sane(1000, 949), false, "more than 5 percent negative deviation should revert");

const depositBody = source.slice(source.indexOf("function _deposit"), source.indexOf("function withdraw"));
assert(depositBody.includes("_requireSaneSharePrice();"), "deposit should validate price sanity");
assert(depositBody.includes("sharesMinted = (amount * totalShares) / totalDeposited;"), "deposit should use internal accounting");
assert(depositBody.includes("sharesMinted >= minShares"), "deposit should enforce minShares");
assert(!depositBody.includes("totalAssets()"), "deposit share math must not use observed assets");

const withdrawBody = source.slice(source.indexOf("function withdraw"), source.indexOf("function addStrategy"));
assert(withdrawBody.includes("assetsReturned = (shareAmount * totalDeposited) / totalShares;"), "withdraw should use internal accounting");
assert(withdrawBody.includes("totalDeposited -= assetsReturned;"), "withdraw should update internal accounting");
assert(!withdrawBody.includes("asset.balanceOf(address(this))"), "withdraw must not use donated token balance");

const addStrategyBody = source.slice(source.indexOf("function addStrategy"), source.indexOf("function allocate"));
assert(addStrategyBody.includes("target != address(0)"), "addStrategy should reject zero address targets");

const sanityBody = source.slice(source.indexOf("function isSharePriceSane"), source.indexOf("function _requireSaneSharePrice"));
assert(sanityBody.includes("totalAssets()"), "sanity check should compare observed assets");
assert(sanityBody.includes("MAX_PRICE_DEVIATION_BPS"), "sanity check should enforce configured deviation");

console.log("YieldAggregator donation protection checks passed");
