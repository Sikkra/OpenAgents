const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ChainlinkAdapter validation", function () {
  async function latestTimestamp() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  async function deployFixture() {
    const [, token] = await ethers.getSigners();
    const Feed = await ethers.getContractFactory("MockChainlinkFeed");
    const primary = await Feed.deploy(8);
    const fallback = await Feed.deploy(8);
    await Promise.all([primary.waitForDeployment(), fallback.waitForDeployment()]);

    const Adapter = await ethers.getContractFactory("ChainlinkAdapter");
    const adapter = await Adapter.deploy();
    await adapter.waitForDeployment();
    await adapter.registerFeed(token.address, await primary.getAddress(), 3600);

    return { token, primary, fallback, adapter };
  }

  it("rejects incomplete rounds", async function () {
    const { token, primary, adapter } = await deployFixture();
    const now = await latestTimestamp();
    await primary.setRoundData(10, 2000_00000000n, now, now, 9);

    await expect(adapter.getPrice(token.address)).to.be.revertedWith("Incomplete round");
  });

  it("reverts on zero or negative prices", async function () {
    const { token, primary, adapter } = await deployFixture();
    const now = await latestTimestamp();

    await primary.setRoundData(10, 0, now, now, 10);
    await expect(adapter.getPrice(token.address)).to.be.revertedWith("Invalid price");

    await primary.setRoundData(11, -1, now, now, 11);
    await expect(adapter.getPrice(token.address)).to.be.revertedWith("Invalid price");
  });

  it("uses a fallback feed when the primary feed is stale", async function () {
    const { token, primary, fallback, adapter } = await deployFixture();
    const now = await latestTimestamp();

    await primary.setRoundData(10, 2000_00000000n, now - 7200, now - 7200, 10);
    await fallback.setRoundData(20, 2100_00000000n, now, now, 20);
    await adapter.setFallbackFeed(token.address, await fallback.getAddress());

    expect(await adapter.getPrice(token.address)).to.equal(2100n * 10n ** 18n);
    expect(await adapter.getFallbackFeed(token.address)).to.equal(await fallback.getAddress());
  });

  it("reverts when stale data has no fresh fallback", async function () {
    const { token, primary, fallback, adapter } = await deployFixture();
    const now = await latestTimestamp();

    await primary.setRoundData(10, 2000_00000000n, now - 7200, now - 7200, 10);
    await expect(adapter.getPrice(token.address)).to.be.revertedWith("Price stale");

    await fallback.setRoundData(20, 2100_00000000n, now - 7200, now - 7200, 20);
    await adapter.setFallbackFeed(token.address, await fallback.getAddress());
    await expect(adapter.getPrice(token.address)).to.be.revertedWith("Fallback price stale");
  });
});
