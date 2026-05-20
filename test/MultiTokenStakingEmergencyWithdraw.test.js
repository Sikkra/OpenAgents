const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MultiTokenStaking emergencyWithdraw", function () {
  async function deployFixture() {
    const [owner, staker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const rewardToken = await Token.deploy("Reward", "RWD");
    await rewardToken.waitForDeployment();
    const stakeToken = await Token.deploy("Stake", "STK");
    await stakeToken.waitForDeployment();

    const MultiTokenStaking = await ethers.getContractFactory("MultiTokenStaking");
    const staking = await MultiTokenStaking.deploy(await rewardToken.getAddress(), 100n);
    await staking.waitForDeployment();

    await rewardToken.mint(await staking.getAddress(), 100000n);
    await stakeToken.mint(staker.address, 1000n);
    await stakeToken.connect(staker).approve(await staking.getAddress(), 1000n);

    await staking.addPool(100n, await stakeToken.getAddress());

    return { owner, staker, rewardToken, stakeToken, staking };
  }

  it("returns staked tokens without distributing rewards and resets accounting", async function () {
    const { staker, rewardToken, stakeToken, staking } = await deployFixture();

    await staking.connect(staker).deposit(0, 100n);
    await ethers.provider.send("evm_increaseTime", [10]);
    await ethers.provider.send("evm_mine");

    expect(await staking.pendingReward(0, staker.address)).to.be.gt(0n);
    const rewardBalanceBefore = await rewardToken.balanceOf(staker.address);

    await expect(staking.connect(staker).emergencyWithdraw(0))
      .to.emit(staking, "EmergencyWithdraw")
      .withArgs(staker.address, 0, 100n);

    const user = await staking.userInfo(0, staker.address);
    const pool = await staking.poolInfo(0);

    expect(user.amount).to.equal(0n);
    expect(user.rewardDebt).to.equal(0n);
    expect(pool.totalStaked).to.equal(0n);
    expect(await stakeToken.balanceOf(staker.address)).to.equal(1000n);
    expect(await rewardToken.balanceOf(staker.address)).to.equal(rewardBalanceBefore);
  });
});
