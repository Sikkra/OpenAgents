const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AMMPool minimum liquidity", function () {
  async function deployPool() {
    const [owner, firstLp, secondLp, trader, donor] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("Token A", "TKNA");
    await tokenA.waitForDeployment();
    const tokenB = await Token.deploy("Token B", "TKNB");
    await tokenB.waitForDeployment();

    const AMMPool = await ethers.getContractFactory("AMMPool");
    const pool = await AMMPool.deploy(await tokenA.getAddress(), await tokenB.getAddress());
    await pool.waitForDeployment();

    for (const signer of [firstLp, secondLp, trader, donor]) {
      await tokenA.mint(signer.address, 200000n);
      await tokenB.mint(signer.address, 200000n);
      await tokenA.connect(signer).approve(await pool.getAddress(), 200000n);
      await tokenB.connect(signer).approve(await pool.getAddress(), 200000n);
    }

    return { owner, firstLp, secondLp, trader, donor, tokenA, tokenB, pool };
  }

  it("locks 1000 LP units on the first deposit", async function () {
    const { firstLp, pool } = await deployPool();

    await expect(pool.connect(firstLp).addLiquidity(10000n, 10000n))
      .to.emit(pool, "LiquidityAdded")
      .withArgs(firstLp.address, 10000n, 10000n, 9000n);

    expect(await pool.MINIMUM_LIQUIDITY()).to.equal(1000n);
    expect(await pool.totalLiquidity()).to.equal(10000n);
    expect(await pool.liquidity(ethers.ZeroAddress)).to.equal(1000n);
    expect(await pool.liquidity(firstLp.address)).to.equal(9000n);
  });

  it("rejects initial deposits that cannot cover the minimum liquidity lock", async function () {
    const { firstLp, pool } = await deployPool();

    await expect(pool.connect(firstLp).addLiquidity(1000n, 1000n)).to.be.revertedWith(
      "Insufficient initial liquidity",
    );
  });

  it("uses internal reserves so token donations do not change pricing", async function () {
    const { firstLp, trader, donor, tokenA, tokenB, pool } = await deployPool();
    const poolAddress = await pool.getAddress();
    await pool.connect(firstLp).addLiquidity(10000n, 10000n);

    await tokenA.connect(donor).transfer(poolAddress, 90000n);
    expect(await pool.getReserves()).to.deep.equal([10000n, 10000n]);

    const amountIn = 1000n;
    const amountInWithFee = amountIn * 9970n;
    const expectedOut = (amountInWithFee * 10000n) / (10000n * 10000n + amountInWithFee);

    await expect(pool.connect(trader).swap(await tokenA.getAddress(), amountIn, expectedOut))
      .to.emit(pool, "Swap")
      .withArgs(trader.address, await tokenA.getAddress(), amountIn, expectedOut);

    expect(await pool.getReserves()).to.deep.equal([11000n, 10000n - expectedOut]);
    expect(await tokenB.balanceOf(trader.address)).to.equal(200000n + expectedOut);
  });

  it("removes liquidity from internal reserves and leaves donated tokens untouched", async function () {
    const { firstLp, donor, tokenA, tokenB, pool } = await deployPool();
    const poolAddress = await pool.getAddress();
    await pool.connect(firstLp).addLiquidity(10000n, 10000n);

    await tokenA.connect(donor).transfer(poolAddress, 50000n);
    await tokenB.connect(donor).transfer(poolAddress, 50000n);

    await expect(pool.connect(firstLp).removeLiquidity(9000n))
      .to.emit(pool, "LiquidityRemoved")
      .withArgs(firstLp.address, 9000n, 9000n);

    expect(await pool.getReserves()).to.deep.equal([1000n, 1000n]);
    expect(await tokenA.balanceOf(poolAddress)).to.equal(51000n);
    expect(await tokenB.balanceOf(poolAddress)).to.equal(51000n);
  });

  it("syncs internal reserves to actual token balances when explicitly called", async function () {
    const { firstLp, donor, tokenA, tokenB, pool } = await deployPool();
    const poolAddress = await pool.getAddress();
    await pool.connect(firstLp).addLiquidity(10000n, 10000n);

    await tokenA.connect(donor).transfer(poolAddress, 500n);
    await tokenB.connect(donor).transfer(poolAddress, 300n);

    await expect(pool.sync()).to.emit(pool, "Sync").withArgs(10500n, 10300n);
    expect(await pool.getReserves()).to.deep.equal([10500n, 10300n]);
  });
});
