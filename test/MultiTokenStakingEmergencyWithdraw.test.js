const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("MultiTokenStaking emergencyWithdraw", function () {
  let staking;
  let stakeToken;
  let rewardToken;
  let owner;
  let staker;

  beforeEach(async function () {
    [owner, staker] = await ethers.getSigners();

    const MockPlainERC20 = await ethers.getContractFactory("MockPlainERC20");
    stakeToken = await MockPlainERC20.deploy("Stake Token", "STK");
    await stakeToken.waitForDeployment();
    rewardToken = await MockPlainERC20.deploy("Reward Token", "RWD");
    await rewardToken.waitForDeployment();

    const MultiTokenStaking = await ethers.getContractFactory("MultiTokenStaking");
    staking = await MultiTokenStaking.deploy(await rewardToken.getAddress(), ethers.parseEther("1"));
    await staking.waitForDeployment();

    await staking.addPool(100, await stakeToken.getAddress());
    await stakeToken.mint(staker.address, ethers.parseEther("100"));
    await rewardToken.mint(await staking.getAddress(), ethers.parseEther("1000"));
  });

  it("returns principal without rewards and updates accounting", async function () {
    const amount = ethers.parseEther("10");
    await stakeToken.connect(staker).approve(await staking.getAddress(), amount);
    await staking.connect(staker).deposit(0, amount);

    await network.provider.send("evm_increaseTime", [3600]);
    await network.provider.send("evm_mine");

    expect(await staking.pendingReward(0, staker.address)).to.be.gt(0);

    await expect(staking.connect(staker).emergencyWithdraw(0))
      .to.emit(staking, "EmergencyWithdraw")
      .withArgs(staker.address, 0, amount);

    const user = await staking.userInfo(0, staker.address);
    const pool = await staking.poolInfo(0);
    expect(user.amount).to.equal(0);
    expect(user.rewardDebt).to.equal(0);
    expect(pool.totalStaked).to.equal(0);
    expect(await stakeToken.balanceOf(staker.address)).to.equal(ethers.parseEther("100"));
    expect(await rewardToken.balanceOf(staker.address)).to.equal(0);
  });

  it("reverts when the user has no stake", async function () {
    await expect(staking.connect(staker).emergencyWithdraw(0))
      .to.be.revertedWith("MultiStaking: nothing to withdraw");
  });
});
