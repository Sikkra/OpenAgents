// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PrizeSplit
/// @notice Distributes prize pool among multiple winners with configurable shares.
/// @dev Winners claim their share after the admin finalizes the round.
contract PrizeSplit {
    uint256 public constant CLAIM_DEADLINE = 90 days;

    address public admin;
    address public treasury;
    uint256 public totalPrize;
    uint256 public roundId;

    struct Round {
        address[] winners;
        uint256 prizePool;
        uint256 finalizedAt;
        uint256 claimedTotal;
        bool finalized;
        bool reclaimed;
        mapping(address => uint256) shares;
        mapping(address => bool) claimed;
    }

    mapping(uint256 => Round) internal rounds;

    event RoundFunded(uint256 indexed roundId, uint256 amount);
    event RoundFinalized(uint256 indexed roundId, uint256 winnerCount);
    event PrizeClaimed(address indexed winner, uint256 amount, uint256 indexed roundId);
    event UnclaimedPrizesReclaimed(uint256 indexed roundId, address indexed treasury, uint256 amount);
    event TreasuryUpdated(address indexed treasury);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    constructor() {
        admin = msg.sender;
        treasury = msg.sender;
    }

    function setTreasury(address newTreasury) external onlyAdmin {
        require(newTreasury != address(0), "Invalid treasury");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function fundRound() external payable onlyAdmin {
        roundId++;
        rounds[roundId].prizePool = msg.value;
        totalPrize += msg.value;
        emit RoundFunded(roundId, msg.value);
    }

    function finalizeRound(uint256 _roundId, address[] calldata winners) external onlyAdmin {
        Round storage round = rounds[_roundId];
        require(!round.finalized, "Already finalized");
        require(round.prizePool > 0, "No prize pool");
        require(winners.length > 0, "No winners");

        uint256 sharePerWinner = round.prizePool / winners.length;

        for (uint256 i = 0; i < winners.length; i++) {
            require(winners[i] != address(0), "Invalid winner");
            round.winners.push(winners[i]);
            round.shares[winners[i]] = sharePerWinner;
        }

        round.finalized = true;
        round.finalizedAt = block.timestamp;
        emit RoundFinalized(_roundId, winners.length);
    }

    function claimPrize(uint256 _roundId) external {
        Round storage round = rounds[_roundId];
        require(round.finalized, "Not finalized");
        require(block.timestamp <= round.finalizedAt + CLAIM_DEADLINE, "Claim expired");
        require(round.shares[msg.sender] > 0, "No share");
        require(!round.claimed[msg.sender], "Already claimed");

        uint256 amount = round.shares[msg.sender];
        round.claimed[msg.sender] = true;
        round.claimedTotal += amount;
        totalPrize -= amount;

        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Transfer failed");

        emit PrizeClaimed(msg.sender, amount, _roundId);
    }

    function reclaimUnclaimedPrizes(uint256 _roundId) external onlyAdmin {
        Round storage round = rounds[_roundId];
        require(round.finalized, "Not finalized");
        require(block.timestamp > round.finalizedAt + CLAIM_DEADLINE, "Claim active");
        require(!round.reclaimed, "Already reclaimed");

        uint256 amount = round.prizePool - round.claimedTotal;
        round.reclaimed = true;
        totalPrize -= amount;

        (bool sent, ) = treasury.call{value: amount}("");
        require(sent, "Treasury transfer failed");

        emit UnclaimedPrizesReclaimed(_roundId, treasury, amount);
    }

    function getShare(uint256 _roundId, address winner) external view returns (uint256) {
        return rounds[_roundId].shares[winner];
    }

    function isClaimed(uint256 _roundId, address winner) external view returns (bool) {
        return rounds[_roundId].claimed[winner];
    }

    function getReclaimableAmount(uint256 _roundId) external view returns (uint256) {
        Round storage round = rounds[_roundId];
        if (!round.finalized || round.reclaimed) {
            return 0;
        }
        return round.prizePool - round.claimedTotal;
    }
}
