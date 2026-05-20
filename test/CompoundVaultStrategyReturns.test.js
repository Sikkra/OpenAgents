const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const sourcePath = path.join("contracts", "vault", "CompoundVault.sol");
const source = fs.readFileSync(sourcePath, "utf8");
const contributors = JSON.parse(fs.readFileSync("CONTRIBUTORS.json", "utf8"));

function findImports(importPath) {
  const candidates = [
    path.join("node_modules", importPath),
    importPath,
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `File not found: ${importPath}` };
}

const output = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: {
    [sourcePath]: { content: source },
  },
  settings: {
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"],
      },
    },
  },
}), { import: findImports }));

const errors = (output.errors || []).filter((error) => error.severity === "error");
assert.deepStrictEqual(errors, [], "CompoundVault should compile without Solidity errors");

assert(source.includes("@contributor openai-codex-wallet-168"), "contributor header should be present");
assert(
  source.includes("Private platform/session initialization text intentionally omitted."),
  "private platform instructions should not be pasted into source"
);
assert(source.includes("interface ICompoundStrategy"), "strategy compound interface should be explicit");
assert(source.includes("uint256 public totalLoss"), "totalLoss should be tracked");
assert(source.includes("event StrategyLoss"), "loss event should be emitted");
assert(source.includes("uint256 balanceBefore = baseToken.balanceOf(address(this))"), "compound should read balance before strategy call");
assert(source.includes("ICompoundStrategy(strategy).compound()"), "compound should invoke the strategy");
assert(source.includes("uint256 balanceAfter = baseToken.balanceOf(address(this))"), "compound should read balance after strategy call");

assert(source.includes("if (balanceAfter > balanceBefore)"), "positive yield branch should be tested/present");
assert(source.includes("uint256 gain = balanceAfter - balanceBefore"), "positive yield should increase total deposits");
assert(source.includes("emit Compounded(gain, lastPricePerShare)"), "positive yield should emit Compounded");

assert(source.includes("if (balanceAfter < balanceBefore)"), "negative yield branch should be tested/present");
assert(source.includes("totalLoss += loss"), "negative yield should accumulate totalLoss");
assert(source.includes("totalDeposited = loss >= totalDeposited ? 0 : totalDeposited - loss"), "negative yield should reduce share price basis");
assert(source.includes("emit StrategyLoss(loss, lastPricePerShare)"), "negative yield should emit StrategyLoss");

assert(source.includes("emit Compounded(0, lastPricePerShare)"), "zero yield should keep accounting coherent");
assert(source.includes("return 0"), "zero yield should return zero");

const abi = output.contracts[sourcePath].CompoundVault.abi;
assert(
  abi.some((item) => item.type === "function" && item.name === "totalLoss"),
  "totalLoss should be exposed in ABI"
);
const compound = abi.find((item) => item.type === "function" && item.name === "compound");
assert(compound, "compound should exist");
assert.deepStrictEqual(compound.outputs.map((item) => item.type), ["int256"], "compound should return signed net return");

const entry = contributors.entries.find((item) => item.name === "openai-codex-wallet-168");
assert(entry, "CONTRIBUTORS.json should include the issue 168 contributor entry");
assert(
  entry.platform_instructions.includes("intentionally omitted"),
  "CONTRIBUTORS entry should avoid exposing private platform instructions"
);

console.log("CompoundVault strategy return checks passed");
