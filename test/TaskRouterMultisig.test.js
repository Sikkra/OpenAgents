const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TaskRouter multisig payouts", function () {
  let registry;
  let router;
  let owner;
  let creator;
  let agentOwner;
  let signer1;
  let signer2;
  let signer3;
  let outsider;
  let agentId;

  beforeEach(async function () {
    [owner, creator, agentOwner, signer1, signer2, signer3, outsider] = await ethers.getSigners();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    registry = await AgentRegistry.deploy(0);
    await registry.waitForDeployment();

    const TaskRouter = await ethers.getContractFactory("TaskRouter");
    router = await TaskRouter.deploy(await registry.getAddress(), 0);
    await router.waitForDeployment();

    await router.setPaymentSigner(signer1.address, true);
    await router.setPaymentSigner(signer2.address, true);
    await router.setPaymentSigner(signer3.address, true);

    const registerTx = await registry.connect(agentOwner).registerAgent("agent", "https://agent.local");
    const receipt = await registerTx.wait();
    const event = receipt.logs.find((log) => log.fragment && log.fragment.name === "AgentRegistered");
    agentId = event.args.agentId;
  });

  async function createAndAssignTask(reward) {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createTx = await router.connect(creator).createTask("do work", deadline, { value: reward });
    const receipt = await createTx.wait();
    const event = receipt.logs.find((log) => log.fragment && log.fragment.name === "TaskCreated");
    const taskId = event.args.taskId;
    await router.connect(agentOwner).assignTask(taskId, agentId);
    return taskId;
  }

  it("pays below-threshold tasks immediately", async function () {
    const reward = ethers.parseEther("0.5");
    const taskId = await createAndAssignTask(reward);

    await expect(router.connect(agentOwner).completeTask(taskId, "0x1234"))
      .to.emit(router, "PaymentExecuted")
      .withArgs(taskId, agentOwner.address, reward);

    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0);
    const approval = await router.paymentApprovals(taskId);
    expect(approval.recipient).to.equal(ethers.ZeroAddress);
  });

  it("holds above-threshold payouts until two signers approve", async function () {
    const reward = ethers.parseEther("2");
    const taskId = await createAndAssignTask(reward);

    await expect(router.connect(agentOwner).completeTask(taskId, "0x1234"))
      .to.emit(router, "LargePaymentPending")
      .withArgs(taskId, agentOwner.address, reward);

    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(reward);

    await router.connect(signer1).approvePayment(taskId);
    let approval = await router.paymentApprovals(taskId);
    expect(approval.approvalCount).to.equal(1);
    expect(approval.executed).to.equal(false);
    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(reward);

    await expect(router.connect(signer2).approvePayment(taskId))
      .to.emit(router, "PaymentExecuted")
      .withArgs(taskId, agentOwner.address, reward);

    approval = await router.paymentApprovals(taskId);
    expect(approval.approvalCount).to.equal(2);
    expect(approval.executed).to.equal(true);
    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0);
  });

  it("rejects duplicate approvals and non-signers", async function () {
    const taskId = await createAndAssignTask(ethers.parseEther("2"));
    await router.connect(agentOwner).completeTask(taskId, "0x1234");

    await router.connect(signer1).approvePayment(taskId);
    await expect(router.connect(signer1).approvePayment(taskId))
      .to.be.revertedWith("TaskRouter: already approved");
    await expect(router.connect(outsider).approvePayment(taskId))
      .to.be.revertedWith("TaskRouter: not signer");
  });

  it("manages the three-signer set", async function () {
    expect(await router.signerCount()).to.equal(3);
    await expect(router.setPaymentSigner(outsider.address, true))
      .to.be.revertedWith("TaskRouter: signer limit");

    await router.setPaymentSigner(signer3.address, false);
    expect(await router.paymentSigners(signer3.address)).to.equal(false);
    expect(await router.signerCount()).to.equal(2);

    await router.setPaymentSigner(outsider.address, true);
    expect(await router.paymentSigners(outsider.address)).to.equal(true);
    expect(await router.signerCount()).to.equal(3);
  });
});
