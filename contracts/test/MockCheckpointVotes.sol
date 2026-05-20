// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockCheckpointVotes {
    mapping(address => uint256) public votes;
    mapping(address => mapping(uint256 => uint256)) public checkpoints;

    function setVotes(address account, uint256 amount) external {
        votes[account] = amount;
        checkpoints[account][block.number] = amount;
    }

    function getVotes(address account) external view returns (uint256) {
        return votes[account];
    }

    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256) {
        for (uint256 i = blockNumber + 1; i > 0; i--) {
            uint256 checkpointBlock = i - 1;
            uint256 checkpointVotes = checkpoints[account][checkpointBlock];
            if (checkpointVotes != 0 || checkpointBlock == 0) {
                return checkpointVotes;
            }
        }
        return 0;
    }
}
