const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "contracts", "lottery", "RandomLottery.sol"),
  "utf8"
);

assert(!source.includes("prevrandao"), "lottery must not use block.prevrandao");
assert(source.includes("MIN_PARTICIPANTS = 3"), "minimum participant count must be three");
assert(source.includes("mapping(uint256 => mapping(address => bytes32)) public commitments"), "commitments must be stored");
assert(source.includes("function revealSecret(bytes32 secret)"), "secret reveal function must exist");
assert(source.includes("keccak256(abi.encodePacked(msg.sender, secret)) == commitment"), "reveal must bind secret to sender");
assert(source.includes("revealedPlayers.length >= MIN_PARTICIPANTS"), "draw must require three reveals");
assert(source.includes("lastDrawTime + drawCooldown"), "draw cooldown must be enforced");
assert(source.includes("pendingPrizes[winner] += prize"), "draw must use pull-based prize accounting");
assert(source.includes("function claimPrizeTo(address payable recipient)"), "winner must be able to redirect prize claim");

console.log("RandomLottery commit-reveal tests passed");
