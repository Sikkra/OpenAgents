const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("AgentRegistry batchRegister", function () {
  const registrationFee = ethers.parseEther("0.01");

  async function deployRegistry() {
    const [owner, registrant] = await ethers.getSigners();
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.deploy(registrationFee);
    await registry.waitForDeployment();
    return { registry, owner, registrant };
  }

  it("registers a batch of one agent and emits the registration event", async function () {
    const { registry, registrant } = await deployRegistry();

    await expect(
      registry
        .connect(registrant)
        .batchRegister(["Solo Agent"], ["https://solo.example"], { value: registrationFee })
    )
      .to.emit(registry, "AgentRegistered")
      .withArgs(anyValue, registrant.address, "Solo Agent");

    const agentId = await registry.ownerAgents(registrant.address, 0);
    const agent = await registry.getAgent(agentId);

    expect(agent.owner).to.equal(registrant.address);
    expect(agent.name).to.equal("Solo Agent");
    expect(agent.endpoint).to.equal("https://solo.example");
    expect(agent.active).to.equal(true);
    expect(await ethers.provider.getBalance(await registry.getAddress())).to.equal(registrationFee);
  });

  it("registers a batch of 50 agents with unique ids and one total fee", async function () {
    const { registry, registrant } = await deployRegistry();
    const names = Array.from({ length: 50 }, (_, i) => `Agent ${i}`);
    const endpoints = names.map((_, i) => `https://agent-${i}.example`);
    const totalFee = registrationFee * 50n;

    const tx = await registry.connect(registrant).batchRegister(names, endpoints, { value: totalFee });
    const receipt = await tx.wait();
    const registeredEvents = receipt.logs
      .filter((log) => log.address === registry.target)
      .map((log) => registry.interface.parseLog(log))
      .filter((event) => event && event.name === "AgentRegistered");

    expect(registeredEvents).to.have.lengthOf(50);
    expect(await ethers.provider.getBalance(await registry.getAddress())).to.equal(totalFee);

    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const agentId = await registry.ownerAgents(registrant.address, i);
      expect(seen.has(agentId)).to.equal(false);
      seen.add(agentId);

      const agent = await registry.getAgent(agentId);
      expect(agent.owner).to.equal(registrant.address);
      expect(agent.name).to.equal(names[i]);
      expect(agent.endpoint).to.equal(endpoints[i]);
      expect(agent.active).to.equal(true);
    }
  });

  it("reverts when batch arrays have different lengths", async function () {
    const { registry, registrant } = await deployRegistry();

    await expect(
      registry.connect(registrant).batchRegister(["Agent A"], [], { value: registrationFee })
    ).to.be.revertedWith("Length mismatch");
  });

  it("reverts when the batch exceeds 50 agents", async function () {
    const { registry, registrant } = await deployRegistry();
    const names = Array.from({ length: 51 }, (_, i) => `Agent ${i}`);
    const endpoints = names.map((_, i) => `https://agent-${i}.example`);

    await expect(
      registry.connect(registrant).batchRegister(names, endpoints, { value: registrationFee * 51n })
    ).to.be.revertedWith("Batch too large");
  });
});
