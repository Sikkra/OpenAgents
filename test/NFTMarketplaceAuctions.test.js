const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("NFTMarketplace auctions", function () {
  async function deployFixture() {
    const [seller, bidder1, bidder2, feeRecipient] = await ethers.getSigners();
    const NFT = await ethers.getContractFactory("MockERC721");
    const nft = await NFT.deploy();
    await nft.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("NFTMarketplace");
    const marketplace = await Marketplace.deploy(250, feeRecipient.address);
    await marketplace.waitForDeployment();

    await nft.mint(seller.address, 1);
    await nft.mint(seller.address, 2);
    await nft.connect(seller).approve(await marketplace.getAddress(), 1);
    await nft.connect(seller).approve(await marketplace.getAddress(), 2);

    return { marketplace, nft, seller, bidder1, bidder2, feeRecipient };
  }

  async function createAuction(marketplace, nft, seller, tokenId, reserve = ethers.parseEther("1")) {
    await marketplace
      .connect(seller)
      .createAuction(await nft.getAddress(), tokenId, ethers.parseEther("0.5"), reserve, 3600);
    return (await marketplace.nextAuctionId()) - 1n;
  }

  it("runs a bid war, enforces 5 percent increments, and refunds previous bidder", async function () {
    const { marketplace, nft, seller, bidder1, bidder2 } = await deployFixture();
    const auctionId = await createAuction(marketplace, nft, seller, 1);

    await marketplace.connect(bidder1).placeBid(auctionId, { value: ethers.parseEther("1") });
    await expect(
      marketplace.connect(bidder2).placeBid(auctionId, { value: ethers.parseEther("1.04") })
    ).to.be.revertedWith("Bid too low");

    await expect(marketplace.connect(bidder2).placeBid(auctionId, { value: ethers.parseEther("1.05") }))
      .to.emit(marketplace, "BidPlaced")
      .withArgs(auctionId, bidder2.address, ethers.parseEther("1.05"));

    const auction = await marketplace.getAuction(auctionId);
    expect(auction.highestBidder).to.equal(bidder2.address);
    expect(await ethers.provider.getBalance(await marketplace.getAddress())).to.equal(ethers.parseEther("1.05"));
  });

  it("returns the NFT and refunds the high bidder when reserve is not met", async function () {
    const { marketplace, nft, seller, bidder1 } = await deployFixture();
    const auctionId = await createAuction(marketplace, nft, seller, 1, ethers.parseEther("2"));

    await marketplace.connect(bidder1).placeBid(auctionId, { value: ethers.parseEther("1") });
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");

    await expect(marketplace.settleAuction(auctionId))
      .to.emit(marketplace, "AuctionSettled")
      .withArgs(auctionId, ethers.ZeroAddress, ethers.parseEther("1"), false);

    expect(await nft.ownerOf(1)).to.equal(seller.address);
    expect(await ethers.provider.getBalance(await marketplace.getAddress())).to.equal(0n);
  });

  it("settles to the highest bidder and pays seller plus platform fee when reserve is met", async function () {
    const { marketplace, nft, seller, bidder1, bidder2, feeRecipient } = await deployFixture();
    const auctionId = await createAuction(marketplace, nft, seller, 1, ethers.parseEther("1"));

    await marketplace.connect(bidder1).placeBid(auctionId, { value: ethers.parseEther("1") });
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");

    const sellerBefore = await ethers.provider.getBalance(seller.address);
    const feeBefore = await ethers.provider.getBalance(feeRecipient.address);

    await expect(marketplace.connect(bidder2).settleAuction(auctionId))
      .to.emit(marketplace, "AuctionSettled")
      .withArgs(auctionId, bidder1.address, ethers.parseEther("1"), true);

    expect(await nft.ownerOf(1)).to.equal(bidder1.address);
    expect(await ethers.provider.getBalance(feeRecipient.address)).to.equal(feeBefore + ethers.parseEther("0.025"));
    expect(await ethers.provider.getBalance(seller.address)).to.equal(sellerBefore + ethers.parseEther("0.975"));
  });
});
