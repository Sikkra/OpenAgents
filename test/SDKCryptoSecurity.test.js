const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

function loadCryptoModule() {
  const sourcePath = path.join(__dirname, "..", "sdk", "src", "utils", "crypto.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const fn = new Function("require", "module", "exports", transpiled);
  fn(require, module, module.exports);
  return { api: module.exports, source };
}

const { api, source } = loadCryptoModule();

assert(!source.includes("Math.random"), "crypto utils must not use Math.random");

const nonceA = api.generateNonce();
const nonceB = api.generateNonce();
assert.match(nonceA, /^[0-9a-f]{32}$/i);
assert.match(nonceB, /^[0-9a-f]{32}$/i);
assert.notStrictEqual(nonceA, nonceB);

const derivedA = api.deriveKey("correct horse battery staple", { iterations: 10000 });
const derivedB = api.deriveKey("correct horse battery staple", { iterations: 10000 });
assert.notStrictEqual(derivedA.salt, derivedB.salt);
assert.strictEqual(derivedA.key.length, 32);

const fixed = api.deriveKey("correct horse battery staple", {
  iterations: 10000,
  salt: derivedA.salt,
});
assert.strictEqual(fixed.key.toString("hex"), derivedA.key.toString("hex"));

const pair = api.generateKeyPair();
const signature = api.signMessage(pair.privateKey, "hello");
assert.strictEqual(api.verifySignature(pair.publicKey, "hello", signature), true);
assert.strictEqual(api.verifySignature(pair.publicKey, "hello", "00"), false);
assert.strictEqual(api.verifySignature(pair.publicKey, "hello", "zzzz"), false);

console.log("SDK crypto security tests passed");
