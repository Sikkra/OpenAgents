const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("PaymentEscrow received amount accounting", function () {
  let escrow;
  let plainToken;
  let feeToken;
  let payer;
  let payee;

  beforeEach(async function () {
    [payer, payee] = await ethers.getSigners();

    const PaymentEscrow = await ethers.getContractFactory("PaymentEscrow");
    escrow = await PaymentEscrow.deploy();
    await escrow.waitForDeployment();

    const MockPlainERC20 = await ethers.getContractFactory("MockPlainERC20");
    plainToken = await MockPlainERC20.deploy();
    await plainToken.waitForDeployment();

    const MockFeeOnTransferToken = await ethers.getContractFactory("MockFeeOnTransferToken");
    feeToken = await MockFeeOnTransferToken.deploy(1000);
    await feeToken.waitForDeployment();

    await plainToken.mint(payer.address, ethers.parseEther("100"));
    await feeToken.mint(payer.address, ethers.parseEther("100"));
  });

  it("rejects zero amount escrows", async function () {
    await expect(escrow.createEscrow(payee.address, await plainToken.getAddress(), 0, 0))
      .to.be.revertedWith("Amount must be > 0");
  });

  it("stores the full amount for normal ERC20 deposits", async function () {
    const amount = ethers.parseEther("10");
    await plainToken.approve(await escrow.getAddress(), amount);

    await expect(escrow.createEscrow(payee.address, await plainToken.getAddress(), amount, 0))
      .to.emit(escrow, "EscrowCreated")
      .withArgs(0, payer.address, amount);

    const stored = await escrow.escrows(0);
    expect(stored.amount).to.equal(amount);
  });

  it("stores actual received balance delta for fee-on-transfer tokens", async function () {
    const amount = ethers.parseEther("10");
    const expectedReceived = ethers.parseEther("9");
    await feeToken.approve(await escrow.getAddress(), amount);

    await expect(escrow.createEscrow(payee.address, await feeToken.getAddress(), amount, 0))
      .to.emit(escrow, "EscrowCreated")
      .withArgs(0, payer.address, expectedReceived);

    const stored = await escrow.escrows(0);
    expect(stored.amount).to.equal(expectedReceived);
    expect(await feeToken.balanceOf(await escrow.getAddress())).to.equal(expectedReceived);
  });

  it("releases only the received amount", async function () {
    const amount = ethers.parseEther("10");
    const expectedReceived = ethers.parseEther("9");
    await feeToken.approve(await escrow.getAddress(), amount);
    await escrow.createEscrow(payee.address, await feeToken.getAddress(), amount, 0);

    await escrow.releaseEscrow(0);

    expect(await feeToken.balanceOf(payee.address)).to.equal(ethers.parseEther("8.1"));
    const stored = await escrow.escrows(0);
    expect(stored.amount).to.equal(expectedReceived);
  });

  it("refunds only the received amount after lock expiry", async function () {
    const amount = ethers.parseEther("10");
    const expectedReceived = ethers.parseEther("9");
    await feeToken.approve(await escrow.getAddress(), amount);
    await escrow.createEscrow(payee.address, await feeToken.getAddress(), amount, 60);

    await network.provider.send("evm_increaseTime", [61]);
    await network.provider.send("evm_mine");

    await expect(escrow.refundEscrow(0))
      .to.emit(escrow, "EscrowRefunded")
      .withArgs(0, payer.address, expectedReceived);
  });
});
