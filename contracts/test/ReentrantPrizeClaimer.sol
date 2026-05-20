// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPrizeSplit {
    function claimPrize(uint256 roundId) external;
}

contract ReentrantPrizeClaimer {
    IPrizeSplit public prizeSplit;
    uint256 public targetRoundId;
    bool public attemptedReentry;
    bool public reentrySucceeded;

    constructor(address _prizeSplit) {
        prizeSplit = IPrizeSplit(_prizeSplit);
    }

    function attack(uint256 roundId) external {
        targetRoundId = roundId;
        prizeSplit.claimPrize(roundId);
    }

    receive() external payable {
        if (!attemptedReentry) {
            attemptedReentry = true;
            (bool ok, ) = address(prizeSplit).call(
                abi.encodeWithSelector(IPrizeSplit.claimPrize.selector, targetRoundId)
            );
            reentrySucceeded = ok;
        }
    }
}
