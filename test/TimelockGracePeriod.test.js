const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Timelock grace period and cancellation", function () {
  const delay = 2 * 24 * 60 * 60;
  const gracePeriod = 14 * 24 * 60 * 60;

  async function deployFixture() {
    const [admin] = await ethers.getSigners();
    const Timelock = await ethers.getContractFactory("Timelock");
    const timelock = await Timelock.deploy(admin.address, delay);
    await timelock.waitForDeployment();

    const Target = await ethers.getContractFactory("TimelockTarget");
    const target = await Target.deploy();
    await target.waitForDeployment();

    return { timelock, target };
  }

  async function queueSetValue(timelock, target, value, etaOffset = delay) {
    const data = target.interface.encodeFunctionData("setValue", [value]);
    const latest = await ethers.provider.getBlock("latest");
    const eta = BigInt(latest.timestamp + etaOffset);
    await timelock.queueTransaction(await target.getAddress(), 0, data, eta);
    return { data, eta };
  }

  it("executes a queued transaction within the eta plus grace window", async function () {
    const { timelock, target } = await deployFixture();
    const { data, eta } = await queueSetValue(timelock, target, 42);

    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(eta)]);
    await ethers.provider.send("evm_mine");

    await expect(timelock.executeTransaction(await target.getAddress(), 0, data, eta))
      .to.emit(timelock, "ExecuteTransaction");
    expect(await target.value()).to.equal(42n);
  });

  it("rejects execution after the grace period expires", async function () {
    const { timelock, target } = await deployFixture();
    const { data, eta } = await queueSetValue(timelock, target, 99);

    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(eta) + gracePeriod + 1]);
    await ethers.provider.send("evm_mine");

    await expect(
      timelock.executeTransaction(await target.getAddress(), 0, data, eta)
    ).to.be.revertedWith("Timelock: tx stale");
  });

  it("lets admin cancel a queued transaction before execution", async function () {
    const { timelock, target } = await deployFixture();
    const { data, eta } = await queueSetValue(timelock, target, 7);

    await expect(timelock.cancelTransaction(await target.getAddress(), 0, data, eta))
      .to.emit(timelock, "CancelTransaction");

    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(eta)]);
    await ethers.provider.send("evm_mine");

    await expect(
      timelock.executeTransaction(await target.getAddress(), 0, data, eta)
    ).to.be.revertedWith("Timelock: tx not queued");
  });
});
