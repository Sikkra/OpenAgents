const { expect } = require("chai");
const { ethers } = require("hardhat");

require("ts-node/register");

const {
  decodeParameter,
  decodeParameters,
} = require("../sdk/src/utils/encoding.ts");

describe("SDK ABI dynamic decoding", function () {
  const coder = ethers.AbiCoder.defaultAbiCoder();

  it("decodes string, dynamic uint array, and uint return values", function () {
    const encoded = coder.encode(
      ["string", "uint256[]", "uint256"],
      ["agent-ready", [1n, 2n, 3n], 42n]
    );

    const decoded = decodeParameters(
      [
        { type: "string", name: "status" },
        { type: "uint256[]", name: "scores" },
        { type: "uint256", name: "count" },
      ],
      encoded
    );

    expect(decoded[0]).to.equal("agent-ready");
    expect(decoded[1]).to.deep.equal([1n, 2n, 3n]);
    expect(decoded[2]).to.equal(42n);
  });

  it("decodes bytes values as buffers", function () {
    const encoded = coder.encode(["bytes"], ["0x1234abcd"]);

    const decoded = decodeParameter("bytes", encoded);

    expect(Buffer.isBuffer(decoded)).to.equal(true);
    expect(decoded.toString("hex")).to.equal("1234abcd");
  });

  it("decodes a named tuple with nested dynamic values", function () {
    const encoded = coder.encode(
      ["tuple(string name,uint256[] scores,uint256 count)"],
      [["agent", [4n, 5n], 2n]]
    );

    const decoded = decodeParameter(
      {
        type: "tuple",
        components: [
          { type: "string", name: "name" },
          { type: "uint256[]", name: "scores" },
          { type: "uint256", name: "count" },
        ],
      },
      encoded
    );

    expect(decoded).to.deep.equal({
      name: "agent",
      scores: [4n, 5n],
      count: 2n,
    });
  });
});
