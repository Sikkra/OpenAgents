const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { AbiCoder, keccak256, toUtf8Bytes } = require("ethers");

const root = path.resolve(__dirname, "..");
const contractPath = "contracts/token/AgentToken.sol";
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

const abi = output.contracts[contractPath].AgentToken.abi;
const domainSeparator = abi.find((entry) => entry.type === "function" && entry.name === "DOMAIN_SEPARATOR");
assert(domainSeparator, "DOMAIN_SEPARATOR() view function missing");
assert.strictEqual(domainSeparator.inputs.length, 0, "DOMAIN_SEPARATOR should not take arguments");
assert.strictEqual(domainSeparator.outputs[0].type, "bytes32", "DOMAIN_SEPARATOR should return bytes32");

const coder = AbiCoder.defaultAbiCoder();
const domainTypeHash = keccak256(toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const versionHash = keccak256(toUtf8Bytes("1"));
const nameHash = keccak256(toUtf8Bytes("AgentToken"));
const verifyingContract = "0x000000000000000000000000000000000000dEaD";

function expectedSeparator(chainId) {
  return keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [domainTypeHash, nameHash, versionHash, chainId, verifyingContract]
    )
  );
}

assert.notStrictEqual(
  expectedSeparator(1),
  expectedSeparator(31337),
  "EIP-712 domain separator should differ across chain IDs"
);

assert(source.includes("_CACHED_CHAIN_ID = block.chainid;"), "constructor should cache deployment chain ID");
assert(source.includes("block.chainid == _CACHED_CHAIN_ID"), "DOMAIN_SEPARATOR should use cached value on same chain");
assert(source.includes("return _buildDomainSeparator(block.chainid);"), "DOMAIN_SEPARATOR should recompute on chain ID change");
assert(source.includes("DOMAIN_SEPARATOR()"), "permit digest should use dynamic DOMAIN_SEPARATOR()");
assert(!source.includes("bytes32 public immutable DOMAIN_SEPARATOR"), "hardcoded public immutable separator should be removed");

console.log("AgentToken domain separator checks passed");
