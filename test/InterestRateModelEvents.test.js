const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("InterestRateModel parameter updates", function () {
  const initialBaseRate = ethers.parseEther("0.02");
  const initialMultiplier = ethers.parseEther("0.1");
  const initialJumpMultiplier = ethers.parseEther("0.5");
  const initialKink = ethers.parseEther("0.8");

  async function deployModel() {
    const [admin, other] = await ethers.getSigners();
    const InterestRateModel = await ethers.getContractFactory("InterestRateModel");
    const model = await InterestRateModel.deploy(
      initialBaseRate,
      initialMultiplier,
      initialJumpMultiplier,
      initialKink
    );
    await model.waitForDeployment();
    return { model, admin, other };
  }

  it("emits old and new parameter values when the admin updates rates", async function () {
    const { model } = await deployModel();

    const nextBaseRate = ethers.parseEther("0.03");
    const nextMultiplier = ethers.parseEther("0.12");
    const nextJumpMultiplier = ethers.parseEther("0.7");
    const nextKink = ethers.parseEther("0.75");

    await expect(model.updateParams(nextBaseRate, nextMultiplier, nextJumpMultiplier, nextKink))
      .to.emit(model, "RateParametersUpdated")
      .withArgs(
        initialBaseRate,
        nextBaseRate,
        initialMultiplier,
        nextMultiplier,
        initialJumpMultiplier,
        nextJumpMultiplier,
        initialKink,
        nextKink
      );
  });

  it("returns all current parameters in one getter call", async function () {
    const { model } = await deployModel();

    let params = await model.getParameters();
    expect(params.baseRate).to.equal(initialBaseRate);
    expect(params.multiplier).to.equal(initialMultiplier);
    expect(params.jumpMultiplier).to.equal(initialJumpMultiplier);
    expect(params.kink).to.equal(initialKink);

    const nextBaseRate = ethers.parseEther("0.025");
    const nextMultiplier = ethers.parseEther("0.14");
    const nextJumpMultiplier = ethers.parseEther("0.65");
    const nextKink = ethers.parseEther("0.82");

    await model.updateParams(nextBaseRate, nextMultiplier, nextJumpMultiplier, nextKink);

    params = await model.getParameters();
    expect(params.baseRate).to.equal(nextBaseRate);
    expect(params.multiplier).to.equal(nextMultiplier);
    expect(params.jumpMultiplier).to.equal(nextJumpMultiplier);
    expect(params.kink).to.equal(nextKink);
  });
});
