const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PrizeSplit pull claims", function () {
  const claimDeadlineSeconds = 90 * 24 * 60 * 60;

  async function deployPrizeSplit() {
    const [admin, winner, otherWinner, treasury] = await ethers.getSigners();

    const PrizeSplit = await ethers.getContractFactory("PrizeSplit");
    const prizeSplit = await PrizeSplit.deploy();
    await prizeSplit.waitForDeployment();

    const RejectEtherWinner = await ethers.getContractFactory("RejectEtherWinner");
    const rejectWinner = await RejectEtherWinner.deploy();
    await rejectWinner.waitForDeployment();

    await prizeSplit.setTreasury(treasury.address);

    return { admin, winner, otherWinner, treasury, prizeSplit, rejectWinner };
  }

  async function fundAndFinalize(prizeSplit, winners, prize = ethers.parseEther("2")) {
    await prizeSplit.fundRound({ value: prize });
    const roundId = await prizeSplit.roundId();
    await prizeSplit.finalizeRound(roundId, winners);
    return roundId;
  }

  async function expireClaims() {
    await ethers.provider.send("evm_increaseTime", [claimDeadlineSeconds + 1]);
    await ethers.provider.send("evm_mine");
  }

  it("lets other winners claim when a contract winner rejects ETH", async function () {
    const { prizeSplit, rejectWinner, winner } = await deployPrizeSplit();
    const rejectWinnerAddress = await rejectWinner.getAddress();
    const roundId = await fundAndFinalize(prizeSplit, [rejectWinnerAddress, winner.address]);

    await expect(rejectWinner.claimPrize(prizeSplit, roundId)).to.be.revertedWith("Transfer failed");
    expect(await prizeSplit.isClaimed(roundId, rejectWinnerAddress)).to.equal(false);

    await expect(prizeSplit.connect(winner).claimPrize(roundId))
      .to.emit(prizeSplit, "PrizeClaimed")
      .withArgs(winner.address, ethers.parseEther("1"), roundId);

    expect(await prizeSplit.isClaimed(roundId, winner.address)).to.equal(true);
    expect(await prizeSplit.totalPrize()).to.equal(ethers.parseEther("1"));
  });

  it("reclaims unclaimed prizes to treasury after the 90 day deadline", async function () {
    const { prizeSplit, winner, otherWinner, treasury } = await deployPrizeSplit();
    const roundId = await fundAndFinalize(prizeSplit, [winner.address, otherWinner.address]);

    await expireClaims();

    await expect(prizeSplit.connect(winner).claimPrize(roundId)).to.be.revertedWith("Claim expired");
    await expect(prizeSplit.reclaimUnclaimedPrizes(roundId))
      .to.emit(prizeSplit, "UnclaimedPrizesReclaimed")
      .withArgs(roundId, treasury.address, ethers.parseEther("2"));

    expect(await ethers.provider.getBalance(await prizeSplit.getAddress())).to.equal(0n);
    expect(await prizeSplit.totalPrize()).to.equal(0n);
  });

  it("reclaims only the remaining balance after partial claims", async function () {
    const { prizeSplit, winner, otherWinner, treasury } = await deployPrizeSplit();
    const roundId = await fundAndFinalize(prizeSplit, [winner.address, otherWinner.address]);

    await prizeSplit.connect(winner).claimPrize(roundId);
    await expireClaims();

    await expect(prizeSplit.reclaimUnclaimedPrizes(roundId))
      .to.emit(prizeSplit, "UnclaimedPrizesReclaimed")
      .withArgs(roundId, treasury.address, ethers.parseEther("1"));

    expect(await prizeSplit.totalPrize()).to.equal(0n);
    expect(await ethers.provider.getBalance(await prizeSplit.getAddress())).to.equal(0n);
  });
});
