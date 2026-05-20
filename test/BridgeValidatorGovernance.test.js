const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BridgeValidator governance controls", function () {
  async function deployFixture() {
    const [owner, validator1, validator2, validator3, validator4] = await ethers.getSigners();
    const BridgeValidator = await ethers.getContractFactory("BridgeValidator");
    const bridgeValidator = await BridgeValidator.deploy(1);
    await bridgeValidator.waitForDeployment();
    return { owner, validator1, validator2, validator3, validator4, bridgeValidator };
  }

  it("only lets the owner add and remove validators", async function () {
    const { validator1, validator2, validator3, validator4, bridgeValidator } = await deployFixture();

    await bridgeValidator.bootstrap(validator1.address, 1);
    await expect(
      bridgeValidator.connect(validator1).addValidator(validator2.address, 1)
    ).to.be.revertedWith("BridgeValidator: not owner");

    await bridgeValidator.addValidator(validator2.address, 1);
    await bridgeValidator.addValidator(validator3.address, 1);
    await bridgeValidator.addValidator(validator4.address, 1);

    await expect(
      bridgeValidator.connect(validator1).removeValidator(validator4.address)
    ).to.be.revertedWith("BridgeValidator: not owner");
  });

  it("keeps at least three active validators after removal", async function () {
    const { validator1, validator2, validator3, validator4, bridgeValidator } = await deployFixture();

    await bridgeValidator.bootstrap(validator1.address, 1);
    await bridgeValidator.addValidator(validator2.address, 1);
    await bridgeValidator.addValidator(validator3.address, 1);

    await expect(bridgeValidator.removeValidator(validator3.address)).to.be.revertedWith(
      "BridgeValidator: minimum validators"
    );

    await bridgeValidator.addValidator(validator4.address, 1);
    await expect(bridgeValidator.removeValidator(validator4.address))
      .to.emit(bridgeValidator, "ValidatorRemoved")
      .withArgs(validator4.address);
    expect(await bridgeValidator.activeValidatorCount()).to.equal(3n);
  });

  it("bounds total validator weight on add and update", async function () {
    const { validator1, validator2, bridgeValidator } = await deployFixture();
    const maxWeight = (1n << 128n) - 1n;

    await bridgeValidator.bootstrap(validator1.address, maxWeight);
    expect(await bridgeValidator.totalWeight()).to.equal(maxWeight);

    await expect(bridgeValidator.addValidator(validator2.address, 1)).to.be.revertedWith(
      "BridgeValidator: total weight too high"
    );
    await expect(bridgeValidator.updateWeight(validator1.address, maxWeight)).to.not.be.reverted;
  });
});
