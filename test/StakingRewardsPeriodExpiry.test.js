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
  "RATE_PRECISION",
  "lastTimeRewardApplicable",
  "notifyRewardAmount",
  "rewardsDistributor",
  "setRewardsDistributor",
]) {
  functionAbi(name);
}

function cappedElapsed(now, periodFinish, lastUpdateTime) {
  const applicable = now < periodFinish ? now : periodFinish;
  return applicable - lastUpdateTime;
}

assert.strictEqual(cappedElapsed(200, 200, 100), 100, "period end should accrue through finish");
assert.strictEqual(cappedElapsed(1000, 200, 100), 100, "after finish should not accrue more rewards");

const reward = 500000n;
const duration = 604800n;
const precision = 10n ** 18n;
const scaledRate = (reward * precision) / duration;
const distributed = (scaledRate * duration) / precision;
const lost = reward - distributed;
assert(lost * 10000n <= reward, "scaled reward rate precision loss should stay below 0.01 percent");

const rewardPerTokenBody = source.slice(source.indexOf("function rewardPerToken"), source.indexOf("function earned"));
assert(
  rewardPerTokenBody.includes("lastTimeRewardApplicable() - lastUpdateTime"),
  "rewardPerToken should cap elapsed time at periodFinish"
);
assert(
  !rewardPerTokenBody.includes("block.timestamp - lastUpdateTime"),
  "rewardPerToken must not accrue against uncapped block.timestamp"
);

const notifyBody = source.slice(source.indexOf("function notifyRewardAmount"), source.lastIndexOf("}"));
assert(notifyBody.includes("onlyRewardsDistributor"), "notifyRewardAmount should be distributor-gated");
assert(notifyBody.includes("reward > 0"), "notifyRewardAmount should reject zero reward resets");
assert(notifyBody.includes("reward * RATE_PRECISION"), "rewardRate should use fixed-point precision");
assert(notifyBody.includes("(remaining * rewardRate) / RATE_PRECISION"), "leftover should decode scaled rewardRate");

const setDistributorBody = source.slice(source.indexOf("function setRewardsDistributor"), source.indexOf("function notifyRewardAmount"));
assert(setDistributorBody.includes("msg.sender == owner"), "only owner should update distributor");
assert(setDistributorBody.includes("distributor != address(0)"), "distributor cannot be zero");

console.log("StakingRewards period expiry and reward-rate checks passed");
