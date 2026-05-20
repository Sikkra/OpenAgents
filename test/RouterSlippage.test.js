const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Router multi-hop slippage controls", function () {
  async function latestTimestamp() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  async function deployFixture() {
    const [admin, trader] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockPlainERC20");
    const tokenA = await Token.deploy("Token A", "TKA");
    const tokenB = await Token.deploy("Token B", "TKB");
    const tokenC = await Token.deploy("Token C", "TKC");
    await Promise.all([
      tokenA.waitForDeployment(),
      tokenB.waitForDeployment(),
      tokenC.waitForDeployment(),
    ]);

    const reserve = ethers.parseEther("10000");
    const Pool = await ethers.getContractFactory("MockRouterPool");
    const poolAB = await Pool.deploy(await tokenA.getAddress(), await tokenB.getAddress(), reserve, reserve);
    const poolBC = await Pool.deploy(await tokenB.getAddress(), await tokenC.getAddress(), reserve, reserve);
    await Promise.all([poolAB.waitForDeployment(), poolBC.waitForDeployment()]);

    for (const [token, pool] of [
      [tokenA, poolAB],
      [tokenB, poolAB],
      [tokenB, poolBC],
      [tokenC, poolBC],
    ]) {
      await token.mint(await pool.getAddress(), reserve);
    }

    const Router = await ethers.getContractFactory("Router");
    const router = await Router.deploy();
    await router.waitForDeployment();
    await router.registerPool(await tokenA.getAddress(), await tokenB.getAddress(), await poolAB.getAddress());
    await router.registerPool(await tokenB.getAddress(), await tokenC.getAddress(), await poolBC.getAddress());

    return { admin, trader, tokenA, tokenB, tokenC, poolAB, poolBC, router };
  }

  it("applies non-zero proportional minimums to each hop", async function () {
    const { trader, tokenA, tokenB, tokenC, poolAB, poolBC, router } = await deployFixture();
    const path = [await tokenA.getAddress(), await tokenB.getAddress(), await tokenC.getAddress()];
    const amountIn = ethers.parseEther("100");
    const quotedOut = await router.getQuote(path, amountIn);
    const minAmountOut = (quotedOut * 95n) / 100n;
    const deadline = (await latestTimestamp()) + 100;

    await tokenA.mint(trader.address, amountIn);
    await tokenA.connect(trader).approve(await router.getAddress(), amountIn);

    await expect(router.connect(trader).swapMultiHop(path, amountIn, minAmountOut, deadline))
      .to.emit(router, "MultiHopSwap");

    expect(await poolAB.lastMinAmountOut()).to.be.gt(0n);
    expect(await poolBC.lastMinAmountOut()).to.equal(minAmountOut);
    expect(await tokenC.balanceOf(trader.address)).to.be.gte(minAmountOut);
  });

  it("rejects circular paths", async function () {
    const { tokenA, tokenB, router } = await deployFixture();
    const path = [await tokenA.getAddress(), await tokenB.getAddress(), await tokenA.getAddress()];
    const deadline = (await latestTimestamp()) + 100;

    await expect(router.swapMultiHop(path, 1, 1, deadline)).to.be.revertedWith("Circular path");
  });

  it("rejects expired deadlines", async function () {
    const { tokenA, tokenB, router } = await deployFixture();
    const path = [await tokenA.getAddress(), await tokenB.getAddress()];
    const expired = (await latestTimestamp()) - 1;

    await expect(router.swapMultiHop(path, 1, 1, expired)).to.be.revertedWith("Deadline expired");
  });

  it("rejects zero input and zero-output hops", async function () {
    const { trader, tokenA, tokenB, router } = await deployFixture();
    const path = [await tokenA.getAddress(), await tokenB.getAddress()];
    const deadline = (await latestTimestamp()) + 100;

    await expect(router.swapMultiHop(path, 0, 1, deadline)).to.be.revertedWith("Zero input");

    await tokenA.mint(trader.address, 1);
    await tokenA.connect(trader).approve(await router.getAddress(), 1);
    await expect(router.connect(trader).swapMultiHop(path, 1, 1, deadline)).to.be.revertedWith("Zero output");
  });
});
