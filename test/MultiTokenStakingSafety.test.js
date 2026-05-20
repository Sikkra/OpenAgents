const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MultiTokenStaking safety", function () {
  async function deployToken(name, symbol) {
    const Token = await ethers.getContractFactory("MockPlainERC20");
    const token = await Token.deploy(name, symbol);
    await token.waitForDeployment();
    return token;
  }

  async function deployStaking(rewardPerSecond = 1n) {
    const [owner, user] = await ethers.getSigners();
    const reward = await deployToken("Reward", "RWD");
    const stake = await deployToken("Stake", "STK");
    const Staking = await ethers.getContractFactory("MultiTokenStaking");
    const staking = await Staking.deploy(await reward.getAddress(), rewardPerSecond);
    await staking.waitForDeployment();
    return { owner, user, reward, stake, staking };
  }

  it("rejects a zero reward token", async function () {
    const Staking = await ethers.getContractFactory("MultiTokenStaking");

    await expect(Staking.deploy(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "MultiStaking: zero reward token"
    );
  });

  it("rejects invalid and duplicate pools", async function () {
    const { staking, stake } = await deployStaking();
    const stakeAddress = await stake.getAddress();

    await expect(staking.addPool(1n, ethers.ZeroAddress)).to.be.revertedWith(
      "MultiStaking: zero stake token"
    );
    await expect(staking.addPool(0n, stakeAddress)).to.be.revertedWith(
      "MultiStaking: zero alloc"
    );

    await expect(staking.addPool(10n, stakeAddress))
      .to.emit(staking, "PoolAdded")
      .withArgs(0n, stakeAddress, 10n);
    await expect(staking.addPool(5n, stakeAddress)).to.be.revertedWith(
      "MultiStaking: duplicate pool"
    );

    expect(await staking.poolExists(stakeAddress)).to.equal(true);
    expect(await staking.totalAllocPoint()).to.equal(10n);
  });

  it("lets the owner rebalance pool allocation weight", async function () {
    const { staking, stake } = await deployStaking();
    await staking.addPool(10n, await stake.getAddress());

    await expect(staking.updatePoolAllocPoint(0n, 25n))
      .to.emit(staking, "PoolAllocPointUpdated")
      .withArgs(0n, 10n, 25n);

    const pool = await staking.poolInfo(0n);
    expect(pool.allocPoint).to.equal(25n);
    expect(await staking.totalAllocPoint()).to.equal(25n);
  });

  it("keeps large reward math in mulDiv-safe ranges", async function () {
    const hugeReward = 1n << 200n;
    const hugeAlloc = 1n << 100n;
    const { staking, stake, user } = await deployStaking(hugeReward);

    await staking.addPool(hugeAlloc, await stake.getAddress());
    await stake.mint(user.address, 1n);
    await stake.connect(user).approve(await staking.getAddress(), 1n);
    await staking.connect(user).deposit(0n, 1n);

    await ethers.provider.send("evm_increaseTime", [1]);
    await ethers.provider.send("evm_mine");

    await expect(staking.pendingReward(0n, user.address)).to.not.be.reverted;
    expect(await staking.pendingReward(0n, user.address)).to.equal(hugeReward);
  });
});
