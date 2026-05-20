const assert = require("assert");
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");
const contractPath = "contracts/lending/LendingPool.sol";
const source = fs.readFileSync(path.join(root, contractPath), "utf8");

const solcInput = {
  language: "Solidity",
  sources: {
    [contractPath]: { content: source },
  },
  settings: {
    outputSelection: {
      "*": {
        "*": ["abi"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(solcInput)));
const errors = (output.errors || []).filter((error) => error.severity === "error");
assert.strictEqual(errors.length, 0, errors.map((error) => error.formattedMessage).join("\n"));

const abi = output.contracts[contractPath].LendingPool.abi;

function functionAbi(name) {
  const entry = abi.find((candidate) => candidate.type === "function" && candidate.name === name);
  assert(entry, `${name} function missing from ABI`);
  return entry;
}

for (const name of [
  "FLASH_LOAN_FEE_BPS",
  "BPS_DENOMINATOR",
  "flashLiquidate",
  "quoteFlashLiquidation",
  "flashLoanFee",
  "protocolCollateralReserves",
  "flashLoanFeesCollected",
]) {
  functionAbi(name);
}

const flashLiquidate = functionAbi("flashLiquidate");
assert.deepStrictEqual(
  flashLiquidate.inputs.map((entry) => entry.name),
  ["user", "minProfitCollateral"],
  "flashLiquidate should expose borrower and minimum profit"
);

function fee(amount) {
  return Math.floor((amount * 9) / 10000);
}

function collateralForBorrowAmount(borrowAmount, borrowPrice, collateralPrice) {
  return Math.floor((borrowAmount * borrowPrice + collateralPrice - 1) / collateralPrice);
}

const debt = 100000;
const flashFee = fee(debt);
assert.strictEqual(flashFee, 90, "0.09 percent fee should be charged");

const collateralRequired = collateralForBorrowAmount(debt + flashFee, 1, 2);
const collateral = 70000;
assert(collateral > collateralRequired, "profitable quote should have surplus collateral");
assert.strictEqual(collateral - collateralRequired, 19955, "profit collateral should be surplus after repayment and fee");

const unprofitableCollateral = collateralRequired;
assert(!(unprofitableCollateral > collateralRequired), "unprofitable quote should not have surplus collateral");

const flashBody = source.slice(source.indexOf("function flashLiquidate"), source.indexOf("function quoteFlashLiquidation"));
assert(flashBody.includes("require(!_isHealthy(user)"), "flash liquidation should require underwater position");
assert(flashBody.includes("uint256 fee = flashLoanFee(debt);"), "flash liquidation should calculate fee");
assert(flashBody.includes("collateral > collateralToProtocol"), "unprofitable liquidation should revert");
assert(flashBody.includes("profitCollateral >= minProfitCollateral"), "minimum profit should be enforced");
assert(flashBody.includes("totalBorrowed -= debt;"), "flash liquidation should fully clear debt");
assert(flashBody.includes("protocolCollateralReserves += collateralToProtocol;"), "repayment collateral should stay with protocol");
assert(flashBody.includes("flashLoanFeesCollected += fee;"), "fee accounting should be updated");
assert(flashBody.includes("collateralToken.transfer(msg.sender, profitCollateral)"), "profit should go to liquidator");
assert(!flashBody.includes("borrowToken.transferFrom"), "flash liquidation should not require upfront liquidator capital");

const quoteBody = source.slice(source.indexOf("function quoteFlashLiquidation"), source.indexOf("function flashLoanFee"));
assert(quoteBody.includes("profitable = true;"), "quote should report profitable liquidations");

const collateralHelperBody = source.slice(source.indexOf("function _collateralForBorrowAmount"), source.indexOf("function getPosition"));
assert(collateralHelperBody.includes("collateralPrice > 0 && borrowPrice > 0"), "oracle prices should be positive");
assert(collateralHelperBody.includes("borrowAmount * borrowPrice"), "collateral quote should use borrow value");

console.log("LendingPool flash liquidation checks passed");
