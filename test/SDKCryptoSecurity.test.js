const { expect } = require("chai");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "CommonJS",
    moduleResolution: "node",
    ignoreDeprecations: "6.0",
  },
});

const {
  deriveKey,
  generateKeyPair,
  generateNonce,
  generateSalt,
  signMessage,
  verifySignature,
} = require("../sdk/src/utils/crypto.ts");

describe("SDK crypto security utilities", function () {
  it("uses CSPRNG nonces without Math.random", function () {
    const originalRandom = Math.random;
    Math.random = () => {
      throw new Error("Math.random must not be used");
    };

    try {
      const first = generateNonce();
      const second = generateNonce();

      expect(first).to.match(/^[0-9a-f]{32}$/);
      expect(second).to.match(/^[0-9a-f]{32}$/);
      expect(first).to.not.equal(second);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("derives keys with unique salts and configurable rounds", function () {
    const first = deriveKey("agent-password", { iterations: 1_000 });
    const second = deriveKey("agent-password", { iterations: 1_000 });

    expect(first.salt).to.not.equal(second.salt);
    expect(first.key.equals(second.key)).to.equal(false);
    expect(first.iterations).to.equal(1_000);

    const replay = deriveKey("agent-password", {
      salt: first.salt,
      iterations: first.iterations,
      keyLength: first.keyLength,
      digest: first.digest,
    });

    expect(replay.key.equals(first.key)).to.equal(true);

    const stronger = deriveKey("agent-password", {
      salt: first.salt,
      iterations: 2_000,
    });
    expect(stronger.key.equals(first.key)).to.equal(false);
  });

  it("validates salt size", function () {
    expect(generateSalt()).to.match(/^[0-9a-f]{32}$/);
    expect(() => generateSalt(8)).to.throw(RangeError);
    expect(() => deriveKey("password", { salt: "0x1234" })).to.throw(RangeError);
  });

  it("rejects malformed signature lengths before verification", function () {
    const { publicKey, privateKey } = generateKeyPair();
    const message = "hello";
    const signature = signMessage(privateKey, message);

    expect(verifySignature(publicKey, message, signature)).to.equal(true);
    expect(verifySignature(publicKey, message, "abcd")).to.equal(false);
    expect(verifySignature(publicKey, message, "abc")).to.equal(false);
    expect(verifySignature(publicKey, message, "ff".repeat(80))).to.equal(false);
  });
});
