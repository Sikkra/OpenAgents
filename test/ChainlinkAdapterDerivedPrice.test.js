const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ChainlinkAdapter derived prices", function () {
  async function deployFeed(decimals, answer, updatedAt) {
    const Feed = await ethers.getContractFactory("MockAggregatorV3");
    const feed = await Feed.deploy(decimals, answer, updatedAt);
    await feed.waitForDeployment();
    return feed;
  }

  async function deployAdapter() {
    const Adapter = await ethers.getContractFactory("ChainlinkAdapter");
    const adapter = await Adapter.deploy();
    await adapter.waitForDeployment();
    return adapter;
  }

  it("uses direct feed prices through getPrice", async function () {
    const [token] = await ethers.getSigners();
    const latest = await ethers.provider.getBlock("latest");
    const adapter = await deployAdapter();
    const feed = await deployFeed(8, 2000_00000000n, latest.timestamp);

    await adapter.registerFeed(token.address, await feed.getAddress(), 3600);

    expect(await adapter.getPrice(token.address)).to.equal(ethers.parseEther("2000"));
  });

  it("derives base over quote price from two normalized feeds", async function () {
    const [base, quote] = await ethers.getSigners();
    const latest = await ethers.provider.getBlock("latest");
    const adapter = await deployAdapter();
    const baseFeed = await deployFeed(8, 2000_00000000n, latest.timestamp);
    const quoteFeed = await deployFeed(8, 1000_00000000n, latest.timestamp);

    await adapter.registerFeed(base.address, await baseFeed.getAddress(), 3600);
    await adapter.registerFeed(quote.address, await quoteFeed.getAddress(), 3600);

    expect(await adapter.derivedPrice(base.address, quote.address)).to.equal(ethers.parseEther("2"));
  });

  it("handles decimal mismatches between component feeds", async function () {
    const [base, quote] = await ethers.getSigners();
    const latest = await ethers.provider.getBlock("latest");
    const adapter = await deployAdapter();
    const baseFeed = await deployFeed(18, ethers.parseEther("1.5"), latest.timestamp);
    const quoteFeed = await deployFeed(8, 50_000000n, latest.timestamp);

    await adapter.registerFeed(base.address, await baseFeed.getAddress(), 3600);
    await adapter.registerFeed(quote.address, await quoteFeed.getAddress(), 3600);

    expect(await adapter.derivedPrice(base.address, quote.address)).to.equal(ethers.parseEther("3"));
  });

  it("rejects stale component feeds", async function () {
    const [base, quote] = await ethers.getSigners();
    const latest = await ethers.provider.getBlock("latest");
    const adapter = await deployAdapter();
    const staleFeed = await deployFeed(8, 2000_00000000n, latest.timestamp - 7200);
    const freshFeed = await deployFeed(8, 1000_00000000n, latest.timestamp);

    await adapter.registerFeed(base.address, await staleFeed.getAddress(), 3600);
    await adapter.registerFeed(quote.address, await freshFeed.getAddress(), 3600);

    await expect(adapter.derivedPrice(base.address, quote.address)).to.be.revertedWith("Stale price");
  });
});
