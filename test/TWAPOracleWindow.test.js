const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TWAPOracle window safety", function () {
  const minWindow = 30 * 60;

  async function deployOracle() {
    const Oracle = await ethers.getContractFactory("TWAPOracle");
    const oracle = await Oracle.deploy(ethers.ZeroAddress);
    await oracle.waitForDeployment();
    return oracle;
  }

  it("defaults to and enforces a 30-minute minimum window", async function () {
    const oracle = await deployOracle();

    expect(await oracle.windowSize()).to.equal(BigInt(minWindow));
    await expect(oracle.setWindowSize(minWindow - 1)).to.be.revertedWith("Window too short");
    await expect(oracle.setWindowSize(minWindow * 2))
      .to.emit(oracle, "WindowUpdated")
      .withArgs(minWindow * 2);
  });

  it("rejects multiple observations in the same block", async function () {
    const oracle = await deployOracle();
    const DoubleRecorder = await ethers.getContractFactory("DoubleTWAPRecorder");
    const recorder = await DoubleRecorder.deploy();
    await recorder.waitForDeployment();

    await expect(recorder.recordTwice(await oracle.getAddress(), 100, 200)).to.be.revertedWith(
      "Observation already recorded"
    );
  });

  it("uses cumulative price over the covered window", async function () {
    const oracle = await deployOracle();

    await oracle.recordObservation(100);
    await ethers.provider.send("evm_increaseTime", [minWindow]);
    await ethers.provider.send("evm_mine");
    await oracle.recordObservation(200);

    expect(await oracle.getTWAP()).to.equal(100n);
    expect(await oracle.getObservationCount()).to.equal(2n);
  });

  it("reverts when the requested window is not covered", async function () {
    const oracle = await deployOracle();
    await oracle.setWindowSize(minWindow * 2);

    await oracle.recordObservation(100);
    await ethers.provider.send("evm_increaseTime", [minWindow]);
    await ethers.provider.send("evm_mine");
    await oracle.recordObservation(200);

    await expect(oracle.getTWAP()).to.be.revertedWith("Window not covered");
  });

  it("reverts on stale latest observations", async function () {
    const oracle = await deployOracle();

    await oracle.recordObservation(100);
    await ethers.provider.send("evm_increaseTime", [minWindow]);
    await ethers.provider.send("evm_mine");
    await oracle.recordObservation(200);

    await ethers.provider.send("evm_increaseTime", [minWindow + 1]);
    await ethers.provider.send("evm_mine");

    await expect(oracle.getTWAP()).to.be.revertedWith("Price stale");
    await expect(oracle.getLatestPrice()).to.be.revertedWith("Price stale");
  });
});
