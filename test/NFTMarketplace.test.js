const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("NFTMarketplace hardening", function () {
  let market;
  let nft;
  let seller;
  let buyer;
  let feeRecipient;
  let royaltyReceiver;

  beforeEach(async function () {
    [seller, buyer, feeRecipient, royaltyReceiver] = await ethers.getSigners();

    const MockRoyaltyNFT = await ethers.getContractFactory("MockRoyaltyNFT");
    nft = await MockRoyaltyNFT.deploy();
    await nft.waitForDeployment();

    const NFTMarketplace = await ethers.getContractFactory("NFTMarketplace");
    market = await NFTMarketplace.deploy(250, feeRecipient.address);
    await market.waitForDeployment();

    await nft.mint(seller.address, 1);
    await nft.connect(seller).approve(await market.getAddress(), 1);
  });

  async function list(price, expiresAt = undefined) {
    if (expiresAt === undefined) {
      const tx = await market.connect(seller).listNFT(await nft.getAddress(), 1, price);
      const receipt = await tx.wait();
      return receipt.logs.find((log) => log.fragment && log.fragment.name === "Listed").args.listingId;
    }

    const tx = await market.connect(seller).listNFTWithExpiry(await nft.getAddress(), 1, price, expiresAt);
    const receipt = await tx.wait();
    return receipt.logs.find((log) => log.fragment && log.fragment.name === "Listed").args.listingId;
  }

  it("rejects zero-price listings", async function () {
    await expect(market.connect(seller).listNFT(await nft.getAddress(), 1, 0))
      .to.be.revertedWith("Zero price");
  });

  it("requires delayed cancellation before canceling a listing", async function () {
    const listingId = await list(ethers.parseEther("1"));

    await expect(market.connect(seller).cancelListing(listingId))
      .to.be.revertedWith("Cancel not requested");

    await market.connect(seller).requestCancel(listingId);
    await expect(market.connect(seller).cancelListing(listingId))
      .to.be.revertedWith("Cancel delay active");

    await network.provider.send("evm_increaseTime", [301]);
    await network.provider.send("evm_mine");

    await expect(market.connect(seller).cancelListing(listingId))
      .to.emit(market, "Canceled")
      .withArgs(listingId);
  });

  it("pays ERC-2981 royalties before seller proceeds", async function () {
    await nft.setTokenRoyalty(royaltyReceiver.address, 1000);
    const price = ethers.parseEther("1");
    const fee = price * 250n / 10000n;
    const royalty = price * 1000n / 10000n;
    const sellerProceeds = price - fee - royalty;
    const listingId = await list(price);

    await expect(() => market.connect(buyer).buyNFT(listingId, { value: price }))
      .to.changeEtherBalances(
        [feeRecipient, royaltyReceiver, seller],
        [fee, royalty, sellerProceeds]
      );

    expect(await nft.ownerOf(1)).to.equal(buyer.address);
  });

  it("blocks expired listing purchases", async function () {
    const latest = await ethers.provider.getBlock("latest");
    const listingId = await list(ethers.parseEther("1"), latest.timestamp + 60);

    await network.provider.send("evm_setNextBlockTimestamp", [latest.timestamp + 61]);
    await network.provider.send("evm_mine");

    await expect(market.connect(buyer).buyNFT(listingId, { value: ethers.parseEther("1") }))
      .to.be.revertedWith("Listing expired");
  });
});
