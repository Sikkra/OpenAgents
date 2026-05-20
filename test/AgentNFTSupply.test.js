const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentNFT supply and URI safety", function () {
  async function deployFixture() {
    const [owner, user1, user2] = await ethers.getSigners();
    const AgentNFT = await ethers.getContractFactory("AgentNFT");
    const nft = await AgentNFT.deploy("Agent", "AGENT", "ipfs://base/");
    await nft.waitForDeployment();
    return { owner, user1, user2, nft };
  }

  it("rejects tokenURI for nonexistent tokens", async function () {
    const { nft } = await deployFixture();
    await expect(nft.tokenURI(0)).to.be.revertedWith("Nonexistent token");
  });

  it("rejects zero-address mints", async function () {
    const { nft } = await deployFixture();
    await expect(nft.mint(ethers.ZeroAddress, "ipfs://agent")).to.be.revertedWith("Mint to zero");
  });

  it("batch mints recipients and preserves explicit URIs", async function () {
    const { user1, user2, nft } = await deployFixture();
    await expect(
      nft.batchMint([user1.address, user2.address], ["ipfs://one", "ipfs://two"])
    )
      .to.emit(nft, "Transfer")
      .withArgs(ethers.ZeroAddress, user1.address, 0);

    expect(await nft.ownerOf(0)).to.equal(user1.address);
    expect(await nft.ownerOf(1)).to.equal(user2.address);
    expect(await nft.tokenURI(0)).to.equal("ipfs://one");
    expect(await nft.tokenURI(1)).to.equal("ipfs://two");
    expect(await nft.totalSupply()).to.equal(2n);
  });

  it("uses the base URI for tokens without explicit metadata", async function () {
    const { user1, nft } = await deployFixture();
    await nft.mint(user1.address, "");
    expect(await nft.tokenURI(0)).to.equal("ipfs://base/0");
  });

  it("caps total supply", async function () {
    const { user1, nft } = await deployFixture();
    const maxSupply = Number(await nft.MAX_SUPPLY());
    const recipients = Array(maxSupply).fill(user1.address);
    const uris = Array(maxSupply).fill("");

    await nft.batchMint(recipients, uris);
    expect(await nft.totalSupply()).to.equal(BigInt(maxSupply));
    await expect(nft.mint(user1.address, "")).to.be.revertedWith("Max supply exceeded");
  });
});
