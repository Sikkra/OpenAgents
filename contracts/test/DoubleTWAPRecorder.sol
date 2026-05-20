// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITWAPOracle {
    function recordObservation(uint256 spotPrice) external;
}

contract DoubleTWAPRecorder {
    function recordTwice(address oracle, uint256 firstPrice, uint256 secondPrice) external {
        ITWAPOracle(oracle).recordObservation(firstPrice);
        ITWAPOracle(oracle).recordObservation(secondPrice);
    }
}
