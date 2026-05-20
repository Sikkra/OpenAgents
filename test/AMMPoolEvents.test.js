const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AMMPool indexer events", function () {
  async function deployPool() {
    const [lp, trader] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Token A", "TKNA");
    const tokenB = await Token.deploy("Token B", "TKNB");
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const Pool = await ethers.getContractFactory("AMMPool");
    const pool = await Pool.deploy(await tokenA.getAddress(), await tokenB.getAddress());
    await pool.waitForDeployment();

    for (const token of [tokenA, tokenB]) {
      await token.mint(lp.address, ethers.parseEther("2000"));
      await token.mint(trader.address, ethers.parseEther("100"));
      await token.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
      await token.connect(trader).approve(await pool.getAddress(), ethers.MaxUint256);
    }

    return { pool, tokenA, tokenB, lp, trader };
  }

  async function seedLiquidity(pool, tokenA, tokenB, lp) {
    const amountA = ethers.parseEther("1000");
    const amountB = ethers.parseEther("1000");
    await pool.connect(lp).addLiquidity(amountA, amountB);
    return { amountA, amountB };
  }

  it("marks Swap user and tokenIn as indexed and emits Sync after swaps", async function () {
    const { pool, tokenA, tokenB, lp, trader } = await deployPool();
    const swapEvent = pool.interface.getEvent("Swap");
    expect(swapEvent.inputs[0].indexed).to.equal(true);
    expect(swapEvent.inputs[1].indexed).to.equal(true);

    const { amountA, amountB } = await seedLiquidity(pool, tokenA, tokenB, lp);
    const amountIn = ethers.parseEther("10");
    const tokenAAddress = await tokenA.getAddress();
    const amountOut = await pool.connect(trader).swap.staticCall(tokenAAddress, amountIn, 0);

    await expect(pool.connect(trader).swap(tokenAAddress, amountIn, 0))
      .to.emit(pool, "Swap")
      .withArgs(trader.address, tokenAAddress, amountIn, amountOut)
      .and.to.emit(pool, "Sync")
      .withArgs(amountA + amountIn, amountB - amountOut);
  });

  it("emits Mint, Burn, and Sync for liquidity changes", async function () {
    const { pool, tokenA, tokenB, lp } = await deployPool();
    const amountA = ethers.parseEther("1000");
    const amountB = ethers.parseEther("1000");

    await expect(pool.connect(lp).addLiquidity(amountA, amountB))
      .to.emit(pool, "Mint")
      .withArgs(lp.address, amountA, amountB)
      .and.to.emit(pool, "Sync")
      .withArgs(amountA, amountB);

    const lpTokens = await pool.liquidity(lp.address);
    const burnTokens = lpTokens / 2n;
    const expectedAmountA = amountA / 2n;
    const expectedAmountB = amountB / 2n;

    await expect(pool.connect(lp).removeLiquidity(burnTokens))
      .to.emit(pool, "Burn")
      .withArgs(lp.address, expectedAmountA, expectedAmountB, lp.address)
      .and.to.emit(pool, "Sync")
      .withArgs(amountA - expectedAmountA, amountB - expectedAmountB);
  });
});
