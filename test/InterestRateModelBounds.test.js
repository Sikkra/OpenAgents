const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("InterestRateModel bounds", function () {
  const precision = 10n ** 18n;
  const baseRate = 10n ** 16n; // 1%
  const multiplier = 10n ** 17n; // 10%
  const jumpMultiplier = 5n * 10n ** 17n; // 50%
  const kink = 8n * 10n ** 17n; // 80%
  const maxUtilization = 9999n * 10n ** 14n;

  async function deployModel(overrides = {}) {
    const Model = await ethers.getContractFactory("InterestRateModel");
    const model = await Model.deploy(
      overrides.baseRate ?? baseRate,
      overrides.multiplier ?? multiplier,
      overrides.jumpMultiplier ?? jumpMultiplier,
      overrides.kink ?? kink
    );
    await model.waitForDeployment();
    return model;
  }

  function expectedRate(utilization) {
    if (utilization <= kink) {
      return baseRate + (utilization * multiplier) / precision;
    }
    const normalRate = baseRate + (kink * multiplier) / precision;
    const excessUtilization = utilization - kink;
    const jumpRate = (excessUtilization * jumpMultiplier) / (precision - kink);
    return normalRate + jumpRate;
  }

  it("calculates rates at 0%, 50%, and 99% utilization", async function () {
    const model = await deployModel();

    expect(await model.getBorrowRate(0, 1000)).to.equal(expectedRate(0n));
    expect(await model.getBorrowRate(500, 1000)).to.equal(expectedRate(5n * 10n ** 17n));
    expect(await model.getBorrowRate(990, 1000)).to.equal(expectedRate(99n * 10n ** 16n));
  });

  it("caps 100% utilization at 99.99% without division by zero", async function () {
    const model = await deployModel({ kink: precision - 1n });

    expect(await model.getUtilization(1000, 1000)).to.equal(maxUtilization);
    await expect(model.getBorrowRate(1000, 1000)).to.not.be.reverted;
    expect(await model.getBorrowRate(1000, 1000)).to.equal(
      baseRate + (maxUtilization * multiplier) / precision
    );
  });

  it("bounds base rate in constructor and updates", async function () {
    const Model = await ethers.getContractFactory("InterestRateModel");
    await expect(Model.deploy(10n ** 15n - 1n, multiplier, jumpMultiplier, kink)).to.be.revertedWith(
      "Base rate too low"
    );
    await expect(Model.deploy(5n * 10n ** 17n + 1n, multiplier, jumpMultiplier, kink)).to.be.revertedWith(
      "Base rate too high"
    );

    const model = await deployModel();
    await expect(model.updateParams(10n ** 15n - 1n, multiplier, jumpMultiplier, kink)).to.be.revertedWith(
      "Base rate too low"
    );
    await expect(model.updateParams(5n * 10n ** 17n + 1n, multiplier, jumpMultiplier, kink)).to.be.revertedWith(
      "Base rate too high"
    );
    await expect(model.updateParams(10n ** 15n, multiplier, jumpMultiplier, kink))
      .to.emit(model, "RateParamsUpdated")
      .withArgs(10n ** 15n, multiplier, jumpMultiplier, kink);
  });

  it("uses safe jump-rate math for extremely large multipliers", async function () {
    const hugeJumpMultiplier = (1n << 255n) - 1n;
    const model = await deployModel({ jumpMultiplier: hugeJumpMultiplier });
    const utilization = await model.getUtilization(990, 1000);
    const normalRate = baseRate + (kink * multiplier) / precision;
    const expectedJump = ((utilization - kink) * hugeJumpMultiplier) / (precision - kink);

    expect(await model.getBorrowRate(990, 1000)).to.equal(normalRate + expectedJump);
  });
});
