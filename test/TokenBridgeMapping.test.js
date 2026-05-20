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

const source = read("contracts/bridge/TokenBridge.sol");
const abi = compile("contracts/bridge/TokenBridge.sol", "TokenBridge");

abiEntry(abi, "function", "tokenMapping");
abiEntry(abi, "function", "addTokenMapping");
abiEntry(abi, "function", "removeTokenMapping");
abiEntry(abi, "function", "computeTransferId");
abiEntry(abi, "function", "computeClaimHash");
abiEntry(abi, "event", "TokenMappingAdded");
abiEntry(abi, "event", "TokenMappingRemoved");

assert(
  source.includes('require(remoteToken != address(0), "Bridge: token not mapped")'),
  "lock and claim paths should reject unmapped tokens"
);
assert(
  source.includes("tokenMapping[token]"),
  "bridge paths should resolve the remote token from tokenMapping"
);
assert(
  source.includes("tokenMapping[localToken] = remoteToken"),
  "admin should be able to add local-to-remote token mappings"
);
assert(
  source.includes("delete tokenMapping[localToken]"),
  "admin should be able to remove token mappings"
);
assert(
  source.includes("keccak256(abi.encodePacked(token, remoteToken, sender, recipient, amount))"),
  "lock transfer hash should bind the local and remote token pair"
);
assert(
  source.includes("keccak256(abi.encodePacked(token, remoteToken, recipient, amount))"),
  "claim hash should bind the local and remote token pair"
);
assert(
  source.includes("remoteToken: remoteToken"),
  "stored transfers should record the mapped remote token"
);

console.log("TokenBridge token mapping checks passed");
