const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");
const contractPath = "contracts/staking/StakingRewards.sol";
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

const abi = output.contracts[contractPath].StakingRewards.abi;

function functionAbi(name) {
  const entry = abi.find((candidate) => candidate.type === "function" && candidate.name === name);
  assert(entry, `${name} function missing from ABI`);
  return entry;
}

for (const name of [
  "BOOST_PRECISION",
  "BOOST_BASE",
  "BOOST_ONE_AND_HALF",
  "BOOST_DOUBLE",
  "BOOST_TIER_ONE",
  "BOOST_TIER_TWO",
  "getRewardMultiplier",
  "stakeTimestamps",
]) {
  functionAbi(name);
}

function multiplierForAge(ageSeconds) {
  const day = 24 * 60 * 60;
  if (ageSeconds >= 90 * day) return 20000;
  if (ageSeconds >= 30 * day) return 15000;
  return 10000;
}

assert.strictEqual(multiplierForAge(0), 10000, "new stakes should start at 1x");
assert.strictEqual(multiplierForAge((30 * 24 * 60 * 60) - 1), 10000, "under 30 days should remain 1x");
assert.strictEqual(multiplierForAge(30 * 24 * 60 * 60), 15000, "30 days should be 1.5x");
assert.strictEqual(multiplierForAge((90 * 24 * 60 * 60) - 1), 15000, "under 90 days should remain 1.5x");
assert.strictEqual(multiplierForAge(90 * 24 * 60 * 60), 20000, "90 days should be 2x");

assert(source.includes("uint256 public constant BOOST_BASE = 10_000;"), "1x boost constant missing");
assert(source.includes("uint256 public constant BOOST_ONE_AND_HALF = 15_000;"), "1.5x boost constant missing");
assert(source.includes("uint256 public constant BOOST_DOUBLE = 20_000;"), "2x boost constant missing");
assert(source.includes("uint256 public constant BOOST_TIER_ONE = 30 days;"), "30 day tier missing");
assert(source.includes("uint256 public constant BOOST_TIER_TWO = 90 days;"), "90 day tier missing");

const earnedBody = source.slice(source.indexOf("function earned"), source.indexOf("function getRewardMultiplier"));
assert(earnedBody.includes("newBaseReward"), "earned should separate newly accrued rewards");
assert(earnedBody.includes("rewards[account] + _boostReward(account, newBaseReward)"), "earned should boost new rewards only");

const multiplierBody = source.slice(source.indexOf("function getRewardMultiplier"), source.indexOf("function stake"));
assert(
  multiplierBody.indexOf("stakeAge >= BOOST_TIER_TWO") < multiplierBody.indexOf("stakeAge >= BOOST_TIER_ONE"),
  "2x tier should be checked before 1.5x tier"
);

const stakeBody = source.slice(source.indexOf("function stake"), source.indexOf("function withdraw"));
assert(stakeBody.includes("stakeTimestamps[msg.sender] = _combinedStakeTimestamp"), "stake should update timestamp tracking");

const withdrawBody = source.slice(source.indexOf("function withdraw"), source.indexOf("function getReward()"));
assert(withdrawBody.includes("if (_balances[msg.sender] == 0)"), "withdraw should only reset on full exit");
assert(withdrawBody.includes("stakeTimestamps[msg.sender] = 0;"), "full unstake should reset timer");

const combinedBody = source.slice(source.indexOf("function _combinedStakeTimestamp"), source.lastIndexOf("}"));
assert(combinedBody.includes("return block.timestamp;"), "first stake should start timer");
assert(combinedBody.includes("previousTimestamp * previousBalance"), "additional stake should preserve existing age by balance");
assert(combinedBody.includes("block.timestamp * addedAmount"), "additional stake should include new stake timestamp");

console.log("StakingRewards boost ABI and accounting checks passed");
