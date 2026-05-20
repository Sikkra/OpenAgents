const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const contractPaths = [
  path.join("contracts", "vault", "YieldAggregator.sol"),
  path.join("contracts", "vault", "CompoundVault.sol"),
];
const sources = Object.fromEntries(
  contractPaths.map((contractPath) => [contractPath, { content: fs.readFileSync(contractPath, "utf8") }])
);
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
  sources,
  settings: {
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"],
      },
    },
  },
}), { import: findImports }));

const errors = (output.errors || []).filter((error) => error.severity === "error");
assert.deepStrictEqual(errors, [], "vault contracts should compile without Solidity errors");

for (const contractPath of contractPaths) {
  const source = fs.readFileSync(contractPath, "utf8");
  assert(source.includes("@openzeppelin/contracts/utils/Pausable.sol"), `${contractPath} should import Pausable`);
  assert(source.includes("Pausable"), `${contractPath} should inherit Pausable`);
  assert(source.includes("@generated-by openai-codex-wallet-32"), `${contractPath} should include generated-by block`);
  assert(
    source.includes("Private platform/session initialization text intentionally omitted."),
    `${contractPath} should not expose private session instructions`
  );
  assert(source.includes("function pause(string calldata reason) external onlyOwner"), `${contractPath} should owner-gate pause`);
  assert(source.includes("emit EmergencyPaused(msg.sender, reason)"), `${contractPath} should emit pause reason`);
  assert(source.includes("function unpause() external onlyOwner"), `${contractPath} should owner-gate unpause`);
  assert(source.includes("emergencyWithdrawn[msg.sender] +="), `${contractPath} should track emergency amounts`);
  assert(source.includes("whenPaused"), `${contractPath} emergency withdraw should require paused state`);
  assert(source.includes("whenNotPaused"), `${contractPath} normal operations should stop while paused`);
}

const yieldSource = fs.readFileSync(contractPaths[0], "utf8");
assert(
  yieldSource.includes("function deposit(uint256 amount) external nonReentrant whenNotPaused"),
  "YieldAggregator deposits should stop when paused"
);
assert(
  yieldSource.includes("function withdraw(uint256 shareAmount) external nonReentrant whenNotPaused"),
  "YieldAggregator withdrawals should stop when paused"
);

const compoundSource = fs.readFileSync(contractPaths[1], "utf8");
assert(
  compoundSource.includes("function deposit(uint256 amount) external nonReentrant whenNotPaused"),
  "CompoundVault deposits should stop when paused"
);
assert(
  compoundSource.includes("function withdraw(uint256 shareAmount) external nonReentrant whenNotPaused"),
  "CompoundVault withdrawals should stop when paused"
);

const entry = contributors.entries.find((item) => item.name === "openai-codex-wallet-32");
assert(entry, "CONTRIBUTORS.json should include the issue 32 contributor entry");
assert(
  entry.platform_instructions.includes("intentionally omitted"),
  "CONTRIBUTORS entry should avoid exposing private platform instructions"
);

console.log("Vault emergency withdrawal checks passed");
