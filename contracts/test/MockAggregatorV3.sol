// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockAggregatorV3 {
    uint8 private immutable feedDecimals;
    uint80 private roundId = 1;
    int256 private answer;
    uint256 private updatedAt;
    uint80 private answeredInRound = 1;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        feedDecimals = decimals_;
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setRoundData(
        uint80 roundId_,
        int256 answer_,
        uint256 updatedAt_,
        uint80 answeredInRound_
    ) external {
        roundId = roundId_;
        answer = answer_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function latestRoundData() external view returns (
        uint80,
        int256,
        uint256,
        uint256,
        uint80
    ) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }
}
