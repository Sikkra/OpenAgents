const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PaymentEscrow dispute and timeout flow", function () {
  async function deployFixture() {
    const [owner, payer, payee, caller] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockPlainERC20");
    const token = await Token.deploy("Mock", "MOCK");
    await token.waitForDeployment();

    const PaymentEscrow = await ethers.getContractFactory("PaymentEscrow");
    const escrow = await PaymentEscrow.deploy();
    await escrow.waitForDeployment();

    return { owner, payer, payee, caller, token, escrow };
  }

  async function createEscrow(token, escrow, payer, payee, amount = 1000n, lockDuration = 0) {
    await token.mint(payer.address, amount);
    await token.connect(payer).approve(await escrow.getAddress(), amount);
    const escrowId = await escrow.escrowCount();
    await escrow.connect(payer).createEscrow(payee.address, await token.getAddress(), amount, lockDuration);
    return escrowId;
  }

  it("lets either escrow party open a dispute", async function () {
    const { payer, payee, token, escrow } = await deployFixture();

    const payerDisputeId = await createEscrow(token, escrow, payer, payee);
    await expect(escrow.connect(payer).dispute(payerDisputeId))
      .to.emit(escrow, "EscrowDisputed")
      .withArgs(payerDisputeId, payer.address);
    expect((await escrow.escrows(payerDisputeId)).disputed).to.equal(true);

    const payeeDisputeId = await createEscrow(token, escrow, payer, payee);
    await expect(escrow.connect(payee).dispute(payeeDisputeId))
      .to.emit(escrow, "EscrowDisputed")
      .withArgs(payeeDisputeId, payee.address);
    expect((await escrow.escrows(payeeDisputeId)).disputed).to.equal(true);
  });

  it("lets the owner resolve a dispute with a split", async function () {
    const { payer, payee, token, escrow } = await deployFixture();
    const escrowId = await createEscrow(token, escrow, payer, payee, 1000n);

    await escrow.connect(payee).dispute(escrowId);
    await expect(escrow.resolveDispute(escrowId, 400n))
      .to.emit(escrow, "DisputeResolved")
      .withArgs(escrowId, 400n, 600n);

    expect(await token.balanceOf(payee.address)).to.equal(400n);
    expect(await token.balanceOf(payer.address)).to.equal(600n);
    const record = await escrow.escrows(escrowId);
    expect(record.released).to.equal(true);
    expect(record.refunded).to.equal(true);
  });

  it("auto-refunds remaining funds after the timeout", async function () {
    const { payer, payee, caller, token, escrow } = await deployFixture();
    const escrowId = await createEscrow(token, escrow, payer, payee, 1000n, 0);
    const timeout = Number(await escrow.REFUND_TIMEOUT());

    await ethers.provider.send("evm_increaseTime", [timeout + 1]);
    await ethers.provider.send("evm_mine");

    await expect(escrow.connect(caller).refundEscrow(escrowId))
      .to.emit(escrow, "EscrowRefunded")
      .withArgs(escrowId, payer.address, 1000n);
    expect(await token.balanceOf(payer.address)).to.equal(1000n);
  });

  it("tracks partial releases and releases the remaining balance", async function () {
    const { payer, payee, token, escrow } = await deployFixture();
    const escrowId = await createEscrow(token, escrow, payer, payee, 1000n);

    await expect(escrow.connect(payer).releasePartial(escrowId, 400n))
      .to.emit(escrow, "EscrowReleased")
      .withArgs(escrowId, payee.address, 400n);
    expect((await escrow.escrows(escrowId)).releasedAmount).to.equal(400n);
    expect((await escrow.escrows(escrowId)).released).to.equal(false);

    await escrow.connect(payer).releaseEscrow(escrowId);
    expect(await token.balanceOf(payee.address)).to.equal(1000n);
    expect((await escrow.escrows(escrowId)).releasedAmount).to.equal(1000n);
    expect((await escrow.escrows(escrowId)).released).to.equal(true);
  });
});
