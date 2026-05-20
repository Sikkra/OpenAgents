const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Timelock delay controls", function () {
  const oneDay = 24 * 60 * 60;
  const maxDelay = 30 * oneDay;

  async function deployTimelock(delay = 2 * oneDay) {
    const [admin, other] = await ethers.getSigners();
    const Timelock = await ethers.getContractFactory("Timelock");
    const timelock = await Timelock.deploy(admin.address, delay);
    await timelock.waitForDeployment();
    return { admin, other, timelock };
  }

  it("enforces constructor delay bounds", async function () {
    const [admin] = await ethers.getSigners();
    const Timelock = await ethers.getContractFactory("Timelock");

    await expect(Timelock.deploy(admin.address, oneDay - 1)).to.be.revertedWith(
      "Timelock: delay below min"
    );
    await expect(Timelock.deploy(admin.address, maxDelay + 1)).to.be.revertedWith(
      "Timelock: delay exceeds max"
    );
  });

  it("restricts delay updates to the admin and keeps them bounded", async function () {
    const { other, timelock } = await deployTimelock();

    await expect(timelock.connect(other).setDelay(oneDay)).to.be.revertedWith(
      "Timelock: caller is not admin"
    );
    await expect(timelock.setDelay(oneDay - 1)).to.be.revertedWith(
      "Timelock: delay below min"
    );
    await expect(timelock.setDelay(maxDelay + 1)).to.be.revertedWith(
      "Timelock: delay exceeds max"
    );

    await expect(timelock.setDelay(oneDay))
      .to.emit(timelock, "NewDelay")
      .withArgs(oneDay);
    expect(await timelock.delay()).to.equal(oneDay);
  });

  it("rejects transactions queued before the active delay elapses", async function () {
    const { timelock } = await deployTimelock(2 * oneDay);
    const block = await ethers.provider.getBlock("latest");
    const tooEarlyEta = block.timestamp + 2 * oneDay - 1;
    const validEta = block.timestamp + 2 * oneDay + 10;

    await expect(
      timelock.queueTransaction(ethers.ZeroAddress, 0, "0x", tooEarlyEta)
    ).to.be.revertedWith("Timelock: eta before delay");

    await expect(timelock.queueTransaction(ethers.ZeroAddress, 0, "0x", validEta))
      .to.emit(timelock, "QueueTransaction");
  });
});
