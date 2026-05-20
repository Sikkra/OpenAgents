const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const sourcePath = path.join("contracts", "governance", "GovernorAlpha.sol");
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
assert.deepStrictEqual(errors, [], "GovernorAlpha should compile without Solidity errors");

assert(source.includes("@contributor openai-codex-wallet-40"), "contributor block should be present");
assert(
  source.includes("Private platform/session initialization text intentionally omitted."),
  "private startup instructions must not be pasted into source"
);
assert(source.includes("uint256 public constant QUORUM_VOTES"), "quorum constant should exist for cancellation");
assert(source.includes("function cancelProposal(uint256 proposalId) public"), "cancelProposal should be available");
assert(source.includes("votesAtCancel < QUORUM_VOTES"), "cancellation should only work before quorum");
assert(source.includes("Governor: quorum reached"), "cancellation should fail once quorum is reached");
assert(source.includes("struct Delegation"), "active delegation should be stored");
assert(source.includes("struct DelegationRecord"), "delegation history records should be stored");
assert(source.includes("expiresAt > block.timestamp"), "new delegations should require future expiry");
assert(source.includes("current.expiresAt >= block.timestamp"), "expired delegations should be inactive");
assert(source.includes("_autoRevokeExpiredDelegation"), "expired delegations should auto-revoke through voting paths");
assert(source.includes("function voteFor(uint256 proposalId, address delegator, bool support)"), "delegated voting should exist");
assert(source.includes("function delegationHistory(address delegator) external view"), "delegation history should be queryable");
assert(!source.includes("tx.origin"), "votes should be cast by msg.sender or explicit delegator, not tx.origin");

const abi = output.contracts[sourcePath].GovernorAlpha.abi;
for (const functionName of [
  "cancelProposal",
  "delegate",
  "clearDelegation",
  "revokeExpiredDelegation",
  "delegationHistory",
  "voteFor",
  "state",
]) {
  assert(
    abi.some((item) => item.type === "function" && item.name === functionName),
    `${functionName} should be exposed in the ABI`
  );
}

const entry = contributors.entries.find((item) => item.name === "openai-codex-wallet-40");
assert(entry, "CONTRIBUTORS.json should include the issue 40 contributor entry");
assert(
  entry.platform_instructions.includes("intentionally omitted"),
  "CONTRIBUTORS entry should avoid exposing private platform instructions"
);

console.log("Governor cancellation and delegation checks passed");
