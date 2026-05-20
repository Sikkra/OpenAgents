const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("GovernorAlpha proposal snapshots", function () {
  let token;
  let governor;
  let proposer;
  let lateBuyer;
  let target;

  beforeEach(async function () {
    [proposer, lateBuyer, target] = await ethers.getSigners();

    const MockCheckpointVotes = await ethers.getContractFactory("MockCheckpointVotes");
    token = await MockCheckpointVotes.deploy();
    await token.waitForDeployment();

    const GovernorAlpha = await ethers.getContractFactory("GovernorAlpha");
    governor = await GovernorAlpha.deploy(await token.getAddress());
    await governor.waitForDeployment();

    await token.setVotes(proposer.address, ethers.parseEther("500000"));
  });

  async function createProposal() {
    const tx = await governor.connect(proposer).propose([target.address], [0], ["0x"]);
    const receipt = await tx.wait();
    const event = receipt.logs.find((log) => log.fragment && log.fragment.name === "ProposalCreated");
    return event.args.id;
  }

  it("stores the proposal creation block as the snapshot", async function () {
    const proposalId = await createProposal();
    const receiptBlock = await ethers.provider.getBlock("latest");

    expect(await governor.proposalSnapshotBlock(proposalId)).to.equal(receiptBlock.number);
    expect(await governor.getVotingPower(proposer.address, proposalId))
      .to.equal(ethers.parseEther("500000"));
  });

  it("ignores tokens acquired after proposal creation", async function () {
    const proposalId = await createProposal();

    await token.setVotes(lateBuyer.address, ethers.parseEther("500000"));
    await network.provider.send("hardhat_mine", ["0x2"]);
    await governor.connect(lateBuyer).vote(proposalId, true);

    expect(await governor.getVotingPower(lateBuyer.address, proposalId)).to.equal(0);
    const proposal = await governor.proposals(proposalId);
    expect(proposal.forVotes).to.equal(0);
  });

  it("keeps original voting power after later balance loss", async function () {
    const proposalId = await createProposal();

    await token.setVotes(proposer.address, 0);
    await network.provider.send("hardhat_mine", ["0x2"]);
    await governor.connect(proposer).vote(proposalId, true);

    expect(await governor.getVotingPower(proposer.address, proposalId))
      .to.equal(ethers.parseEther("500000"));
    const proposal = await governor.proposals(proposalId);
    expect(proposal.forVotes).to.equal(ethers.parseEther("500000"));
  });
});
