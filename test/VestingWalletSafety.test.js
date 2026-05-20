const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VestingWallet safety fixes", function () {
  async function latestTimestamp() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  async function deployFixture(overrides = {}) {
    const [owner, beneficiary] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockPlainERC20");
    const token = await Token.deploy("Mock", "MOCK");
    await token.waitForDeployment();

    const start = overrides.start ?? ((await latestTimestamp()) + 100);
    const cliffDuration = overrides.cliffDuration ?? 0;
    const vestingDuration = overrides.vestingDuration ?? 1000;
    const totalAllocation = overrides.totalAllocation ?? ethers.parseEther("1000");
    const revocable = overrides.revocable ?? true;

    const VestingWallet = await ethers.getContractFactory("VestingWallet");
    const wallet = await VestingWallet.deploy(
      overrides.beneficiary ?? beneficiary.address,
      await token.getAddress(),
      start,
      cliffDuration,
      vestingDuration,
      totalAllocation,
      revocable
    );
    await wallet.waitForDeployment();

    return { owner, beneficiary, token, wallet, start, vestingDuration, totalAllocation };
  }

  it("rejects a zero-address beneficiary", async function () {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockPlainERC20");
    const token = await Token.deploy("Mock", "MOCK");
    await token.waitForDeployment();

    const VestingWallet = await ethers.getContractFactory("VestingWallet");
    await expect(
      VestingWallet.deploy(
        ethers.ZeroAddress,
        await token.getAddress(),
        (await latestTimestamp()) + 100,
        0,
        1000,
        ethers.parseEther("1"),
        true
      )
    ).to.be.revertedWith("Vesting: zero beneficiary");
  });

  it("calculates large 18-decimal allocations without overflowing", async function () {
    const oneYear = 365 * 24 * 60 * 60;
    const totalAllocation = ethers.parseEther("1000000000");
    const { wallet, start } = await deployFixture({
      vestingDuration: oneYear,
      totalAllocation,
    });

    await ethers.provider.send("evm_setNextBlockTimestamp", [start + oneYear / 2]);
    await ethers.provider.send("evm_mine");

    expect(await wallet.vestedAmount()).to.equal(totalAllocation / 2n);
  });

  it("refunds the full unclaimed allocation when revoked during the cliff", async function () {
    const oneDay = 24 * 60 * 60;
    const oneYear = 365 * oneDay;
    const totalAllocation = ethers.parseEther("1000");
    const { owner, token, wallet } = await deployFixture({
      cliffDuration: oneDay,
      vestingDuration: oneYear,
      totalAllocation,
    });
    const walletAddress = await wallet.getAddress();
    await token.mint(walletAddress, totalAllocation);

    await expect(wallet.revoke())
      .to.emit(wallet, "VestingRevoked")
      .withArgs(await token.getAddress(), totalAllocation);

    expect(await token.balanceOf(owner.address)).to.equal(totalAllocation);
    expect(await token.balanceOf(walletAddress)).to.equal(0n);
  });

  it("refunds total allocation minus already released tokens on revoke", async function () {
    const totalAllocation = ethers.parseEther("1000");
    const { owner, beneficiary, token, wallet, start } = await deployFixture({
      vestingDuration: 1000,
      totalAllocation,
    });
    const walletAddress = await wallet.getAddress();
    await token.mint(walletAddress, totalAllocation);

    await ethers.provider.send("evm_setNextBlockTimestamp", [start + 250]);
    await wallet.connect(beneficiary).release();

    const released = ethers.parseEther("250");
    const refund = totalAllocation - released;
    expect(await token.balanceOf(beneficiary.address)).to.equal(released);

    await expect(wallet.revoke())
      .to.emit(wallet, "VestingRevoked")
      .withArgs(await token.getAddress(), refund);
    expect(await token.balanceOf(owner.address)).to.equal(refund);
    expect(await token.balanceOf(walletAddress)).to.equal(0n);
  });
});
