const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BridgeValidator security controls", function () {
  async function deployBridgeValidator() {
    const [owner, validator1, validator2, validator3, validator4, outsider] = await ethers.getSigners();

    const BridgeValidator = await ethers.getContractFactory("BridgeValidator");
    const bridgeValidator = await BridgeValidator.deploy(2);
    await bridgeValidator.waitForDeployment();

    return { owner, validator1, validator2, validator3, validator4, outsider, bridgeValidator };
  }

  async function bootstrapThree(bridgeValidator, validator1, validator2, validator3) {
    await bridgeValidator.bootstrap(validator1.address, 1);
    await bridgeValidator.addValidator(validator2.address, 1);
    await bridgeValidator.addValidator(validator3.address, 1);
  }

  it("restricts validator additions to the owner", async function () {
    const { validator1, validator2, bridgeValidator } = await deployBridgeValidator();
    await bridgeValidator.bootstrap(validator1.address, 1);

    await expect(bridgeValidator.connect(validator1).addValidator(validator2.address, 1)).to.be.revertedWith(
      "BridgeValidator: not owner",
    );

    await bridgeValidator.addValidator(validator2.address, 1);
    expect((await bridgeValidator.validators(validator2.address)).isActive).to.equal(true);
    expect(await bridgeValidator.activeValidatorCount()).to.equal(2n);
  });

  it("rejects zero address validators", async function () {
    const { bridgeValidator } = await deployBridgeValidator();

    await expect(bridgeValidator.bootstrap(ethers.ZeroAddress, 1)).to.be.revertedWith(
      "BridgeValidator: zero address",
    );
  });

  it("prevents removal below three active validators", async function () {
    const { validator1, validator2, validator3, bridgeValidator } = await deployBridgeValidator();
    await bootstrapThree(bridgeValidator, validator1, validator2, validator3);

    await expect(bridgeValidator.removeValidator(validator1.address)).to.be.revertedWith(
      "BridgeValidator: minimum validators",
    );
    expect(await bridgeValidator.activeValidatorCount()).to.equal(3n);
  });

  it("allows removal from four active validators down to three", async function () {
    const { validator1, validator2, validator3, validator4, bridgeValidator } = await deployBridgeValidator();
    await bootstrapThree(bridgeValidator, validator1, validator2, validator3);
    await bridgeValidator.addValidator(validator4.address, 1);

    await expect(bridgeValidator.removeValidator(validator4.address))
      .to.emit(bridgeValidator, "ValidatorRemoved")
      .withArgs(validator4.address);

    expect(await bridgeValidator.activeValidatorCount()).to.equal(3n);
    expect((await bridgeValidator.validators(validator4.address)).isActive).to.equal(false);
  });
});
