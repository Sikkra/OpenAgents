const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("YieldAggregator", function () {
  let token;
  let vault;
  let owner;
  let alice;
  let bob;
  let attacker;

  const depositAmount = ethers.parseEther("100");

  beforeEach(async function () {
    [owner, alice, bob, attacker] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Mock Asset", "MA");
    await token.waitForDeployment();

    const YieldAggregator = await ethers.getContractFactory("YieldAggregator");
    vault = await YieldAggregator.deploy(await token.getAddress());
    await vault.waitForDeployment();
  });

  async function mintAndApprove(user, amount) {
    await token.mint(user.address, amount);
    await token.connect(user).approve(await vault.getAddress(), amount);
  }

  it("reverts when minted shares are below minShares", async function () {
    await mintAndApprove(alice, depositAmount);

    await expect(
      vault.connect(alice).deposit(depositAmount, depositAmount + 1n)
    ).to.be.revertedWith("Vault: insufficient shares");
  });

  it("prices deposits from internal accounting instead of donated balance", async function () {
    await mintAndApprove(alice, depositAmount);
    await vault.connect(alice).deposit(depositAmount, depositAmount);

    const smallDonation = ethers.parseEther("4");
    await token.mint(attacker.address, smallDonation);
    await token.connect(attacker).transfer(await vault.getAddress(), smallDonation);

    await mintAndApprove(bob, depositAmount);
    await vault.connect(bob).deposit(depositAmount, depositAmount);

    expect(await vault.totalAssets()).to.equal(ethers.parseEther("200"));
    expect(await vault.actualManagedAssets()).to.equal(ethers.parseEther("204"));
    expect(await vault.shares(bob.address)).to.equal(depositAmount);
  });

  it("reverts deposits when actual assets deviate by more than five percent", async function () {
    await mintAndApprove(alice, depositAmount);
    await vault.connect(alice).deposit(depositAmount, depositAmount);

    const largeDonation = ethers.parseEther("6");
    await token.mint(attacker.address, largeDonation);
    await token.connect(attacker).transfer(await vault.getAddress(), largeDonation);

    await mintAndApprove(bob, depositAmount);
    await expect(
      vault.connect(bob).deposit(depositAmount, 0)
    ).to.be.revertedWith("Vault: price deviation");
  });

  it("withdraws against accounted assets, not donated token balance", async function () {
    await mintAndApprove(alice, depositAmount);
    await vault.connect(alice).deposit(depositAmount, depositAmount);

    const smallDonation = ethers.parseEther("4");
    await token.mint(attacker.address, smallDonation);
    await token.connect(attacker).transfer(await vault.getAddress(), smallDonation);

    const before = await token.balanceOf(alice.address);
    const redeemedShares = ethers.parseEther("50");
    await vault.connect(alice).withdraw(redeemedShares);
    const after = await token.balanceOf(alice.address);

    expect(after - before).to.equal(redeemedShares);
    expect(await vault.totalAssets()).to.equal(ethers.parseEther("50"));
    expect(await vault.totalShares()).to.equal(ethers.parseEther("50"));
  });

  it("rejects zero-address strategies", async function () {
    await expect(
      vault.connect(owner).addStrategy(ethers.ZeroAddress)
    ).to.be.revertedWith("Vault: zero strategy");
  });
});
