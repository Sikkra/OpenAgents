// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// @contributor sikkra-codex-random-lottery
// @platform-config Private platform/session initialization text intentionally omitted.
// @env os=windows; arch=x64; home_dir=C:\Users\Ben; working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell=powershell
// @timestamp 2026-05-20T08:24:00Z

/// @title RandomLottery
/// @notice Commit-reveal lottery with pull-based prize claims.
/// @dev Players buy tickets with a commitment hash, reveal after the round, and
///      final entropy is produced from at least three revealed participant secrets.
contract RandomLottery {
    uint256 public constant MIN_PARTICIPANTS = 3;
    uint256 public constant DEFAULT_REVEAL_DURATION = 1 hours;

    address public owner;
    uint256 public ticketPrice;
    uint256 public roundEnd;
    uint256 public revealEnd;
    uint256 public currentRound;
    uint256 public drawCooldown;
    uint256 public lastDrawTime;
    uint256 public currentPrizePool;
    bytes32 public roundEntropy;

    address[] public players;
    address[] public revealedPlayers;
    mapping(uint256 => address) public roundWinners;
    mapping(address => uint256) public pendingPrizes;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bool)) public revealed;

    event TicketPurchased(address indexed player, uint256 round, bytes32 commitment);
    event SecretRevealed(address indexed player, uint256 round);
    event RoundStarted(uint256 indexed round, uint256 endTime, uint256 revealEnd);
    event WinnerSelected(address indexed winner, uint256 prize, uint256 round);
    event PrizeClaimed(address indexed winner, address indexed recipient, uint256 amount);
    event DrawCooldownUpdated(uint256 cooldown);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(uint256 _ticketPrice) {
        owner = msg.sender;
        ticketPrice = _ticketPrice;
        drawCooldown = 1 hours;
    }

    function startRound(uint256 duration) external onlyOwner {
        _startRound(duration, DEFAULT_REVEAL_DURATION);
    }

    function startRound(uint256 duration, uint256 revealDuration) external onlyOwner {
        _startRound(duration, revealDuration);
    }

    function _startRound(uint256 duration, uint256 revealDuration) internal {
        require(roundEnd == 0 || block.timestamp > revealEnd, "Round active");
        require(duration > 0, "Invalid duration");
        require(revealDuration > 0, "Invalid reveal duration");
        require(currentPrizePool == 0, "Prize pending draw");

        delete players;
        delete revealedPlayers;
        currentRound++;
        roundEnd = block.timestamp + duration;
        revealEnd = roundEnd + revealDuration;
        roundEntropy = bytes32(0);

        emit RoundStarted(currentRound, roundEnd, revealEnd);
    }

    function buyTicket(bytes32 commitment) external payable {
        require(block.timestamp < roundEnd, "Round ended");
        require(msg.value == ticketPrice, "Wrong ticket price");
        require(commitment != bytes32(0), "Empty commitment");
        require(commitments[currentRound][msg.sender] == bytes32(0), "Already entered");

        commitments[currentRound][msg.sender] = commitment;
        players.push(msg.sender);
        currentPrizePool += msg.value;
        emit TicketPurchased(msg.sender, currentRound, commitment);
    }

    function revealSecret(bytes32 secret) external {
        require(block.timestamp >= roundEnd, "Reveal not started");
        require(block.timestamp <= revealEnd, "Reveal ended");
        bytes32 commitment = commitments[currentRound][msg.sender];
        require(commitment != bytes32(0), "No ticket");
        require(!revealed[currentRound][msg.sender], "Already revealed");
        require(
            keccak256(abi.encodePacked(msg.sender, secret)) == commitment,
            "Invalid secret"
        );

        revealed[currentRound][msg.sender] = true;
        revealedPlayers.push(msg.sender);
        roundEntropy = keccak256(abi.encodePacked(roundEntropy, secret, msg.sender));
        emit SecretRevealed(msg.sender, currentRound);
    }

    function drawWinner() external onlyOwner {
        require(block.timestamp > revealEnd, "Reveal active");
        require(players.length >= MIN_PARTICIPANTS, "Too few participants");
        require(revealedPlayers.length >= MIN_PARTICIPANTS, "Too few reveals");
        require(
            lastDrawTime == 0 || block.timestamp >= lastDrawTime + drawCooldown,
            "Draw cooldown"
        );

        uint256 randomIndex = uint256(roundEntropy) % revealedPlayers.length;
        address winner = revealedPlayers[randomIndex];
        roundWinners[currentRound] = winner;

        uint256 prize = currentPrizePool;
        currentPrizePool = 0;
        roundEnd = 0;
        revealEnd = 0;
        lastDrawTime = block.timestamp;
        pendingPrizes[winner] += prize;

        emit WinnerSelected(winner, prize, currentRound);
    }

    function claimPrize() external {
        claimPrizeTo(payable(msg.sender));
    }

    function claimPrizeTo(address payable recipient) public {
        require(recipient != address(0), "Zero recipient");
        uint256 amount = pendingPrizes[msg.sender];
        require(amount > 0, "No prize");

        pendingPrizes[msg.sender] = 0;
        (bool sent, ) = recipient.call{value: amount}("");
        if (!sent) {
            pendingPrizes[msg.sender] = amount;
            revert("Prize transfer failed");
        }

        emit PrizeClaimed(msg.sender, recipient, amount);
    }

    function setDrawCooldown(uint256 cooldown) external onlyOwner {
        drawCooldown = cooldown;
        emit DrawCooldownUpdated(cooldown);
    }

    function getPlayers() external view returns (address[] memory) {
        return players;
    }

    function getRevealedPlayers() external view returns (address[] memory) {
        return revealedPlayers;
    }

    function getPoolSize() external view returns (uint256) {
        return currentPrizePool;
    }
}
