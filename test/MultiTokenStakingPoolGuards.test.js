const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MultiTokenStaking pool guards", function () {
  async function deployFixture(rewardPerSecond = 100n) {
    const [owner, staker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const rewardToken = await Token.deploy("Reward", "RWD");
    await rewardToken.waitForDeployment();
    const stakeToken = await Token.deploy("Stake", "STK");
    await stakeToken.waitForDeployment();
    const otherStakeToken = await Token.deploy("Other Stake", "OSTK");
    await otherStakeToken.waitForDeployment();

    const MultiTokenStaking = await ethers.getContractFactory("MultiTokenStaking");
    const staking = await MultiTokenStaking.deploy(await rewardToken.getAddress(), rewardPerSecond);
    await staking.waitForDeployment();

    await stakeToken.mint(staker.address, 1000n);
    await stakeToken.connect(staker).approve(await staking.getAddress(), 1000n);

    return { owner, staker, rewardToken, stakeToken, otherStakeToken, staking };
  }

  it("rejects zero reward and stake token addresses", async function () {
    const MultiTokenStaking = await ethers.getContractFactory("MultiTokenStaking");
    await expect(MultiTokenStaking.deploy(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "MultiStaking: zero reward token",
    );

    const { staking } = await deployFixture();
    await expect(staking.addPool(1n, ethers.ZeroAddress)).to.be.revertedWith("MultiStaking: zero stake token");
  });

  it("rejects duplicate staking token pools", async function () {
    const { stakeToken, staking } = await deployFixture();
    const stakeTokenAddress = await stakeToken.getAddress();

    await staking.addPool(100n, stakeTokenAddress);
    expect(await staking.poolExists(stakeTokenAddress)).to.equal(true);

    await expect(staking.addPool(100n, stakeTokenAddress)).to.be.revertedWith("MultiStaking: duplicate pool");
  });

  it("continues to accrue rewards through the safe reward helper", async function () {
    const { staker, stakeToken, staking } = await deployFixture();
    await staking.addPool(100n, await stakeToken.getAddress());
    await staking.connect(staker).deposit(0, 100n);

    await ethers.provider.send("evm_increaseTime", [10]);
    await ethers.provider.send("evm_mine");

    expect(await staking.pendingReward(0, staker.address)).to.equal(1000n);
  });
});
