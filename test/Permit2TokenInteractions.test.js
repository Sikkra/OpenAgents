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

function functionAbi(abi, name) {
  const entry = abi.find((candidate) => candidate.type === "function" && candidate.name === name);
  assert(entry, `${name} function missing from ABI`);
  return entry;
}

const permit2Source = read("contracts/utils/Permit2Transfer.sol");
assert(
  permit2Source.includes("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  "Permit2 helper should use canonical Permit2 address"
);
assert(permit2Source.includes("PermitTransferFrom"), "Permit2 helper should use PermitTransferFrom");
assert(permit2Source.includes("SignatureTransferDetails"), "Permit2 helper should use SignatureTransferDetails");

const stakingAbi = compile("contracts/staking/StakingRewards.sol", "StakingRewards");
functionAbi(stakingAbi, "stake");
const stakeWithPermit2 = functionAbi(stakingAbi, "stakeWithPermit2");
assert.deepStrictEqual(
  stakeWithPermit2.inputs.map((entry) => entry.name),
  ["amount", "nonce", "deadline", "signature"],
  "stakeWithPermit2 should take Permit2 signature fields"
);

const ammAbi = compile("contracts/dex/AMMPool.sol", "AMMPool");
functionAbi(ammAbi, "addLiquidity");
functionAbi(ammAbi, "swap");
const addLiquidityWithPermit2 = functionAbi(ammAbi, "addLiquidityWithPermit2");
assert.strictEqual(addLiquidityWithPermit2.inputs.length, 8, "addLiquidityWithPermit2 should take two Permit2 signatures");
const swapWithPermit2 = functionAbi(ammAbi, "swapWithPermit2");
assert.deepStrictEqual(
  swapWithPermit2.inputs.map((entry) => entry.name),
  ["tokenIn", "amountIn", "minAmountOut", "nonce", "deadline", "signature"],
  "swapWithPermit2 should take swap params and Permit2 signature fields"
);

const lendingAbi = compile("contracts/lending/LendingPool.sol", "LendingPool");
functionAbi(lendingAbi, "deposit");
functionAbi(lendingAbi, "repay");
functionAbi(lendingAbi, "liquidate");
functionAbi(lendingAbi, "depositWithPermit2");
functionAbi(lendingAbi, "repayWithPermit2");
functionAbi(lendingAbi, "liquidateWithPermit2");

for (const file of [
  "contracts/staking/StakingRewards.sol",
  "contracts/dex/AMMPool.sol",
  "contracts/lending/LendingPool.sol",
]) {
  const source = read(file);
  assert(source.includes("Permit2Transfer.sol"), `${file} should import Permit2 helper`);
  assert(source.includes("Permit2Transfer.permitTransferFrom"), `${file} should call Permit2 transfer helper`);
}

assert(read("contracts/staking/StakingRewards.sol").includes("stakingToken.safeTransferFrom"), "staking fallback approve flow should remain");
assert(read("contracts/dex/AMMPool.sol").includes("transferFrom(msg.sender"), "AMM fallback approve flow should remain");
assert(read("contracts/lending/LendingPool.sol").includes("transferFrom(msg.sender"), "lending fallback approve flow should remain");

console.log("Permit2 token interaction checks passed");
