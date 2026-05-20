const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PrizeSplit safety fixes", function () {
  async function deployFixture() {
    const [admin, winner1, winner2, winner3] = await ethers.getSigners();
    const PrizeSplit = await ethers.getContractFactory("PrizeSplit");
    const prizeSplit = await PrizeSplit.deploy();
    await prizeSplit.waitForDeployment();
    return { admin, winner1, winner2, winner3, prizeSplit };
  }

  it("rejects finalization with zero winners", async function () {
    const { prizeSplit } = await deployFixture();
    await prizeSplit.fundRound({ value: 10 });
    await expect(prizeSplit.finalizeRound(1, [])).to.be.revertedWith("No winners");
  });

  it("assigns rounding dust to the final winner", async function () {
    const { winner1, winner2, winner3, prizeSplit } = await deployFixture();
    await prizeSplit.fundRound({ value: 10 });
    await prizeSplit.finalizeRound(1, [winner1.address, winner2.address, winner3.address]);

    expect(await prizeSplit.getShare(1, winner1.address)).to.equal(3n);
    expect(await prizeSplit.getShare(1, winner2.address)).to.equal(3n);
    expect(await prizeSplit.getShare(1, winner3.address)).to.equal(4n);
  });

  it("marks claims before transfer and blocks reentrant claims", async function () {
    const { winner2, prizeSplit } = await deployFixture();
    const Attacker = await ethers.getContractFactory("ReentrantPrizeClaimer");
    const attacker = await Attacker.deploy(await prizeSplit.getAddress());
    await attacker.waitForDeployment();

    await prizeSplit.fundRound({ value: ethers.parseEther("1") });
    await prizeSplit.finalizeRound(1, [await attacker.getAddress(), winner2.address]);

    await expect(attacker.attack(1)).to.changeEtherBalance(attacker, ethers.parseEther("0.5"));
    expect(await attacker.attemptedReentry()).to.equal(true);
    expect(await attacker.reentrySucceeded()).to.equal(false);
    expect(await prizeSplit.isClaimed(1, await attacker.getAddress())).to.equal(true);

    await expect(attacker.attack(1)).to.be.revertedWith("Already claimed");
  });
});
