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
  decodeHex,
  decodeInt256,
  decodeUint256,
  encodeAddress,
  encodeBytes32,
  encodeInt256,
  encodeParams,
  encodeUint256,
} = require("../sdk/src/utils/encoding.ts");

describe("SDK ABI encoding bounds", function () {
  it("pads uint256 values and rejects overflow or negative values", function () {
    expect(encodeUint256(1n)).to.equal("0".repeat(63) + "1");
    expect(encodeUint256((1n << 256n) - 1n)).to.equal("f".repeat(64));

    expect(() => encodeUint256(1n << 256n)).to.throw(RangeError);
    expect(() => encodeUint256(-1n)).to.throw(RangeError);
    expect(() => encodeUint256(Number.MAX_SAFE_INTEGER + 1)).to.throw(RangeError);
  });

  it("requires 0x-prefixed hex inputs", function () {
    expect(() => decodeHex("ff")).to.throw("must start with 0x");
    expect(() => encodeAddress("1234567890123456789012345678901234567890")).to.throw("must start with 0x");
    expect(() => encodeBytes32("abcd")).to.throw("must start with 0x");

    expect(decodeHex("0xff")).to.equal(255n);
  });

  it("encodes and decodes signed int256 values", function () {
    const min = -(1n << 255n);
    const max = (1n << 255n) - 1n;

    expect(encodeInt256(-1n)).to.equal("f".repeat(64));
    expect(encodeInt256(min)).to.equal("8" + "0".repeat(63));
    expect(encodeInt256(max)).to.equal("7" + "f".repeat(63));
    expect(decodeInt256("0x" + "f".repeat(64))).to.equal(-1n);
    expect(decodeInt256("0x" + "8" + "0".repeat(63))).to.equal(min);

    expect(() => encodeInt256(min - 1n)).to.throw(RangeError);
    expect(() => encodeInt256(max + 1n)).to.throw(RangeError);
  });

  it("encodes params with padded signed and unsigned words", function () {
    const encoded = encodeParams([
      { type: "uint256", value: 42n },
      { type: "int256", value: -2n },
      { type: "bytes32", value: "0x1234" },
      { type: "address", value: "0x1111111111111111111111111111111111111111" },
    ]);

    expect(encoded).to.equal(
      "0x" +
        "0".repeat(62) + "2a" +
        "f".repeat(63) + "e" +
        "1234" + "0".repeat(60) +
        "0".repeat(24) + "1111111111111111111111111111111111111111"
    );

    expect(decodeUint256("0x" + "0".repeat(62) + "2a")).to.equal(42n);
  });
});
