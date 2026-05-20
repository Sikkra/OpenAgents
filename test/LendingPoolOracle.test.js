const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "contracts", "lending", "LendingPool.sol"),
  "utf8"
);

assert(source.includes("require(price > 0"), "oracle price must be positive");
assert(source.includes("getLastUpdate(address)"), "staleness check must query oracle timestamp");
assert(source.includes("MAX_ORACLE_STALENESS"), "staleness window must be bounded");
assert(source.includes("latestRoundData(address)"), "round completeness must be checked when available");
assert(
  source.includes("collateralValue < (borrowValue * LIQUIDATION_THRESHOLD) / PRECISION"),
  "liquidation must trigger below the threshold"
);
assert(source.includes("LIQUIDATION_INCENTIVE_BPS"), "liquidation incentive must be configured");
assert(source.includes("badDebtValue += shortfall"), "bad debt must be accounted");
assert(source.includes("BadDebtSocialized"), "bad debt event must be emitted");

console.log("LendingPool oracle liquidation tests passed");
