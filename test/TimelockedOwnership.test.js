const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Timelocked ownership transfers", function () {
  const delay = 2 * 24 * 60 * 60;

  async function deployContracts() {
    const [owner, pendingOwner, feeRecipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockPlainERC20");
    const token = await Token.deploy("Mock", "MOCK");
    await token.waitForDeployment();

    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.deploy(0);
    await registry.waitForDeployment();

    const PaymentEscrow = await ethers.getContractFactory("PaymentEscrow");
    const escrow = await PaymentEscrow.deploy();
    await escrow.waitForDeployment();

    const CompoundVault = await ethers.getContractFactory("CompoundVault");
    const compoundVault = await CompoundVault.deploy(
      await token.getAddress(),
      await token.getAddress(),
      ethers.ZeroAddress,
      feeRecipient.address,
      0
    );
    await compoundVault.waitForDeployment();

    const YieldAggregator = await ethers.getContractFactory("YieldAggregator");
    const yieldAggregator = await YieldAggregator.deploy(await token.getAddress());
    await yieldAggregator.waitForDeployment();

    const MultiTokenStaking = await ethers.getContractFactory("MultiTokenStaking");
    const staking = await MultiTokenStaking.deploy(await token.getAddress(), 1);
    await staking.waitForDeployment();

    const AgentToken = await ethers.getContractFactory("AgentToken");
    const agentToken = await AgentToken.deploy("Agent", "AGENT", 0);
    await agentToken.waitForDeployment();

    return {
      owner,
      pendingOwner,
      contracts: [registry, escrow, compoundVault, yieldAggregator, staking, agentToken],
    };
  }

  it("queues and accepts ownership transfers across owner-controlled contracts", async function () {
    const { owner, pendingOwner, contracts } = await deployContracts();

    for (const contract of contracts) {
      await expect(contract.transferOwnership(pendingOwner.address))
        .to.emit(contract, "OwnershipTransferQueued");
      expect(await contract.owner()).to.equal(owner.address);
      expect(await contract.pendingOwner()).to.equal(pendingOwner.address);
      expect(await contract.ownershipTransferReadyAt()).to.be.gt(0n);
    }

    await ethers.provider.send("evm_increaseTime", [delay]);
    await ethers.provider.send("evm_mine");

    for (const contract of contracts) {
      await expect(contract.connect(pendingOwner).acceptOwnership())
        .to.emit(contract, "OwnershipTransferred")
        .withArgs(owner.address, pendingOwner.address);
      expect(await contract.owner()).to.equal(pendingOwner.address);
      expect(await contract.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await contract.ownershipTransferReadyAt()).to.equal(0n);
    }
  });

  it("blocks early acceptance and lets the pending owner accept after the delay", async function () {
    const { owner, pendingOwner, contracts } = await deployContracts();
    const registry = contracts[0];

    await registry.transferOwnership(pendingOwner.address);
    await expect(registry.connect(pendingOwner).acceptOwnership()).to.be.revertedWith(
      "TimelockedOwnable: transfer locked"
    );

    await ethers.provider.send("evm_increaseTime", [delay]);
    await ethers.provider.send("evm_mine");

    await expect(registry.connect(pendingOwner).acceptOwnership())
      .to.emit(registry, "OwnershipTransferred")
      .withArgs(owner.address, pendingOwner.address);

    expect(await registry.owner()).to.equal(pendingOwner.address);
    expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(await registry.ownershipTransferReadyAt()).to.equal(0n);
  });

  it("lets the current owner cancel a pending transfer", async function () {
    const { pendingOwner, contracts } = await deployContracts();
    const registry = contracts[0];

    await registry.transferOwnership(pendingOwner.address);
    await expect(registry.cancelTransfer())
      .to.emit(registry, "OwnershipTransferCanceled");

    expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(await registry.ownershipTransferReadyAt()).to.equal(0n);

    await ethers.provider.send("evm_increaseTime", [delay]);
    await ethers.provider.send("evm_mine");
    await expect(registry.connect(pendingOwner).acceptOwnership()).to.be.revertedWith(
      "TimelockedOwnable: not pending owner"
    );
  });
});
