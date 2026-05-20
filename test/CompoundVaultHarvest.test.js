const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "contracts", "vault", "CompoundVault.sol"),
  "utf8"
);

assert(source.includes("modifier onlyHarvester()"), "harvest must be restricted");
assert(
  /function harvest\(\) external nonReentrant onlyHarvester/.test(source),
  "harvest must use nonReentrant and onlyHarvester"
);
assert(source.includes("uint256 public minHarvestProfit"), "harvest threshold must be stored");
assert(
  source.includes('require(estimatedValue >= minHarvestProfit, "Vault: below harvest threshold")'),
  "below-threshold harvests must revert"
);
assert(source.includes("uint256 currentPricePerShare = _currentPricePerShare();"), "harvest must use fresh PPS");
assert(source.includes("if (fee == 0)"), "fee minimum branch must be present");
assert(source.includes("fee = 1;"), "non-zero performance fee must round up to one token");
assert(source.includes("function setKeeper(address _keeper) external onlyOwner"), "owner must manage keeper");
assert(
  source.includes("function setMinHarvestProfit(uint256 _minHarvestProfit) external onlyOwner"),
  "owner must manage threshold"
);

console.log("CompoundVault harvest hardening static tests passed");
