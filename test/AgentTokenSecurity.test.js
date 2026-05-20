const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentToken security controls", function () {
  async function deployToken(initialSupply = 1000n) {
    const [owner, holder, spender, other] = await ethers.getSigners();

    const AgentToken = await ethers.getContractFactory("AgentToken");
    const token = await AgentToken.deploy("Agent Token", "AGENT", initialSupply);
    await token.waitForDeployment();

    return { owner, holder, spender, other, token };
  }

  it("restricts minting to the owner", async function () {
    const { owner, other, token } = await deployToken();

    await expect(token.connect(other).mint(other.address, 1n)).to.be.revertedWith("AgentToken: not owner");

    await token.connect(owner).mint(other.address, 250n);
    expect(await token.balanceOf(other.address)).to.equal(250n);
  });

  it("caps initial and future supply", async function () {
    const { owner, other, token } = await deployToken();
    const maxSupply = await token.MAX_SUPPLY();
    const remaining = maxSupply - (await token.totalSupply());

    await token.connect(owner).mint(other.address, remaining);
    await expect(token.connect(owner).mint(other.address, 1n)).to.be.revertedWith("AgentToken: cap exceeded");

    const AgentToken = await ethers.getContractFactory("AgentToken");
    await expect(AgentToken.deploy("Too Much", "TOO", maxSupply + 1n)).to.be.revertedWith(
      "AgentToken: cap exceeded",
    );
  });

  it("rejects expired permits before accepting a signature", async function () {
    const { holder, spender, token } = await deployToken();
    await token.mint(holder.address, 100n);

    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latest.timestamp - 1);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const nonce = await token.nonces(holder.address);

    const signature = await holder.signTypedData(
      {
        name: "Agent Token",
        version: "1",
        chainId,
        verifyingContract: await token.getAddress(),
      },
      {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        owner: holder.address,
        spender: spender.address,
        value: 50n,
        nonce,
        deadline,
      },
    );
    const { v, r, s } = ethers.Signature.from(signature);

    await expect(token.permit(holder.address, spender.address, 50n, deadline, v, r, s)).to.be.revertedWith(
      "AgentToken: expired permit",
    );
  });

  it("burns holder tokens", async function () {
    const { holder, token } = await deployToken();
    await token.mint(holder.address, 100n);

    await token.connect(holder).burn(40n);

    expect(await token.balanceOf(holder.address)).to.equal(60n);
    expect(await token.totalSupply()).to.equal(1060n);
  });
});
