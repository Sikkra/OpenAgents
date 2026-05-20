const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PrizeSplit pull claims", function () {
  const deadlineSeconds = 90 * 24 * 60 * 60;

  async function deployPrizeSplit() {
    const [admin, winner, otherWinner] = await ethers.getSigners();
    const PrizeSplit = await ethers.getContractFactory("PrizeSplit");
    const prizeSplit = await PrizeSplit.deploy();
    await prizeSplit.waitForDeployment();

    const RejectEthWinner = await ethers.getContractFactory("RejectEthWinner");
    const rejectWinner = await RejectEthWinner.deploy();
    await rejectWinner.waitForDeployment();

    return { prizeSplit, rejectWinner, admin, winner, otherWinner };
  }

  async function fundAndFinalize(prizeSplit, winners, prize = ethers.parseEther("2")) {
    await prizeSplit.fundRound({ value: prize });
    const roundId = await prizeSplit.roundId();
    await prizeSplit.finalizeRound(roundId, winners);
    return roundId;
  }

  it("lets other winners claim when a contract winner rejects ETH", async function () {
    const { prizeSplit, rejectWinner, winner } = await deployPrizeSplit();
    const roundId = await fundAndFinalize(prizeSplit, [await rejectWinner.getAddress(), winner.address]);

    await expect(rejectWinner.claimPrize(prizeSplit, roundId)).to.be.revertedWith("Transfer failed");
    await expect(prizeSplit.connect(winner).claimPrize(roundId))
      .to.emit(prizeSplit, "PrizeClaimed")
      .withArgs(winner.address, ethers.parseEther("1"), roundId);

    expect(await prizeSplit.isClaimed(roundId, winner.address)).to.equal(true);
    expect(await prizeSplit.isClaimed(roundId, await rejectWinner.getAddress())).to.equal(false);
  });

  it("reclaims unclaimed prizes to treasury after the 90 day deadline", async function () {
    const { prizeSplit, admin, winner, otherWinner } = await deployPrizeSplit();
    const roundId = await fundAndFinalize(prizeSplit, [winner.address, otherWinner.address]);

    await ethers.provider.send("evm_increaseTime", [deadlineSeconds + 1]);
    await ethers.provider.send("evm_mine");

    await expect(prizeSplit.connect(winner).claimPrize(roundId)).to.be.revertedWith("Claim expired");
    await expect(prizeSplit.reclaimUnclaimedPrizes(roundId))
      .to.emit(prizeSplit, "UnclaimedPrizesReclaimed")
      .withArgs(roundId, admin.address, ethers.parseEther("2"));

    expect(await ethers.provider.getBalance(await prizeSplit.getAddress())).to.equal(0n);
    expect(await prizeSplit.totalPrize()).to.equal(0n);
  });

  it("reclaims only the remaining balance after partial claims", async function () {
    const { prizeSplit, winner, otherWinner } = await deployPrizeSplit();
    const roundId = await fundAndFinalize(prizeSplit, [winner.address, otherWinner.address]);

    await prizeSplit.connect(winner).claimPrize(roundId);
    await ethers.provider.send("evm_increaseTime", [deadlineSeconds + 1]);
    await ethers.provider.send("evm_mine");

    await expect(prizeSplit.reclaimUnclaimedPrizes(roundId))
      .to.emit(prizeSplit, "UnclaimedPrizesReclaimed")
      .withArgs(roundId, await prizeSplit.treasury(), ethers.parseEther("1"));

    expect(await prizeSplit.totalPrize()).to.equal(0n);
  });
});
