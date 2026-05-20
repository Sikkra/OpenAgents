const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FlashLoan", function () {
  let token;
  let flashLoan;
  let receiver;
  let owner;
  let user;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy();
    await token.waitForDeployment();

    const FlashLoan = await ethers.getContractFactory("FlashLoan");
    flashLoan = await FlashLoan.deploy(await token.getAddress());
    await flashLoan.waitForDeployment();

    const FlashLoanReceiverMock = await ethers.getContractFactory("FlashLoanReceiverMock");
    receiver = await FlashLoanReceiverMock.deploy(await token.getAddress());
    await receiver.waitForDeployment();

    await token.mint(owner.address, ethers.parseEther("1000"));
    await token.mint(await receiver.getAddress(), ethers.parseEther("100"));
    await token.approve(await flashLoan.getAddress(), ethers.parseEther("1000"));
    await flashLoan.deposit(ethers.parseEther("1000"));
  });

  it("charges at least one token unit for tiny loans", async function () {
    expect(await flashLoan.flashFee(1)).to.equal(1);

    await flashLoan.flashLoan(await receiver.getAddress(), 1, "0x");

    expect(await receiver.lastFee()).to.equal(1);
    expect(await flashLoan.accountedLiquidity()).to.equal(ethers.parseEther("1000") + 1n);
  });

  it("rejects loans above half of accounted pool liquidity", async function () {
    const maxLoan = await flashLoan.maxFlashLoan();

    await expect(flashLoan.flashLoan(await receiver.getAddress(), maxLoan + 1n, "0x"))
      .to.be.revertedWith("FlashLoan: exceeds max loan");
  });

  it("allows loans up to half of accounted pool liquidity", async function () {
    const maxLoan = await flashLoan.maxFlashLoan();

    await flashLoan.flashLoan(await receiver.getAddress(), maxLoan, "0x");

    expect(await receiver.called()).to.equal(true);
  });

  it("reverts if the borrower does not repay amount plus fee", async function () {
    await receiver.setRepay(false);

    await expect(flashLoan.flashLoan(await receiver.getAddress(), ethers.parseEther("10"), "0x"))
      .to.be.revertedWith("FlashLoan: not repaid");
  });

  it("pauses and unpauses flash loans", async function () {
    await flashLoan.pause();
    await expect(flashLoan.flashLoan(await receiver.getAddress(), 1, "0x"))
      .to.be.revertedWithCustomError(flashLoan, "EnforcedPause");

    await flashLoan.unpause();
    await flashLoan.flashLoan(await receiver.getAddress(), 1, "0x");
  });

  it("tracks internal liquidity separately from unsolicited token transfers", async function () {
    await token.connect(user).mint(user.address, ethers.parseEther("100"));
    await token.connect(user).transfer(await flashLoan.getAddress(), ethers.parseEther("10"));

    expect(await flashLoan.accountedLiquidity()).to.equal(ethers.parseEther("1000"));
    expect(await flashLoan.maxFlashLoan()).to.equal(ethers.parseEther("500"));

    await flashLoan.syncAccountedLiquidity();

    expect(await flashLoan.accountedLiquidity()).to.equal(ethers.parseEther("1010"));
  });
});
