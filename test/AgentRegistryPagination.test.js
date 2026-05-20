const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentRegistry active count and pagination", function () {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
    const registry = await AgentRegistry.deploy(0);
    await registry.waitForDeployment();
    return { owner, alice, bob, registry };
  }

  async function register(registry, signer, name) {
    const tx = await registry.connect(signer).registerAgent(name, `${name}.example`);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => registry.interface.parseLog(log))
      .find((parsed) => parsed.name === "AgentRegistered");
    return event.args.agentId;
  }

  it("maintains an O(1) active counter through registration and deactivation", async function () {
    const { alice, bob, registry } = await deployFixture();

    const aliceOne = await register(registry, alice, "alice-one");
    await register(registry, alice, "alice-two");
    await register(registry, bob, "bob-one");

    expect(await registry.activeCount()).to.equal(3n);
    expect(await registry.getActiveAgentCount()).to.equal(3n);

    await expect(registry.connect(alice).deactivateAgent(aliceOne))
      .to.emit(registry, "AgentDeactivated")
      .withArgs(aliceOne);

    expect(await registry.activeCount()).to.equal(2n);
    expect(await registry.getActiveAgentCount()).to.equal(2n);
    await expect(registry.connect(alice).deactivateAgent(aliceOne)).to.be.revertedWith("Agent inactive");
  });

  it("returns paginated global agent ids", async function () {
    const { alice, bob, registry } = await deployFixture();
    const ids = [
      await register(registry, alice, "alice-one"),
      await register(registry, bob, "bob-one"),
      await register(registry, alice, "alice-two"),
    ];

    expect(await registry.getAgents(0, 2)).to.deep.equal(ids.slice(0, 2));
    expect(await registry.getAgents(2, 2)).to.deep.equal(ids.slice(2, 3));
    expect(await registry.getAgents(10, 2)).to.deep.equal([]);
    expect(await registry.getAgents(0, 0)).to.deep.equal([]);
  });

  it("returns paginated owner-filtered agent ids", async function () {
    const { alice, bob, registry } = await deployFixture();
    const aliceIds = [
      await register(registry, alice, "alice-one"),
      await register(registry, alice, "alice-two"),
      await register(registry, alice, "alice-three"),
    ];
    await register(registry, bob, "bob-one");

    expect(await registry.getAgentsByOwner(alice.address, 1, 2)).to.deep.equal(aliceIds.slice(1, 3));
    expect(await registry.getAgentsByOwner(bob.address, 0, 10)).to.have.length(1);
  });
});
