// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RandomLottery
/// @notice On-chain lottery using block.prevrandao for randomness
/// @dev Players buy tickets, and a random winner is selected after the round ends.
contract RandomLottery {
    address public owner;
    uint256 public ticketPrice;
    uint256 public roundEnd;
    uint256 public currentRound;
    uint256 public minParticipants = 2;
    uint256 public outstandingRefunds;
    bool public roundCanceled;

    address[] public players;
    mapping(uint256 => address) public roundWinners;
    mapping(address => uint256) public refundableAmount;

    event TicketPurchased(address indexed player, uint256 round);
    event RoundStarted(uint256 indexed round, uint256 endTime);
    event WinnerSelected(address indexed winner, uint256 prize, uint256 round);
    event RoundCanceled(uint256 indexed round, uint256 refundAmount);
    event Refunded(address indexed player, uint256 amount, uint256 round);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(uint256 _ticketPrice) {
        owner = msg.sender;
        ticketPrice = _ticketPrice;
    }

    function startRound(uint256 duration) external onlyOwner {
        _startRound(duration, minParticipants);
    }

    function startRound(uint256 duration, uint256 minimumParticipants) external onlyOwner {
        _startRound(duration, minimumParticipants);
    }

    function buyTicket() external payable {
        require(roundEnd != 0 && block.timestamp < roundEnd, "Round ended");
        require(!roundCanceled, "Round canceled");
        require(msg.value == ticketPrice, "Wrong ticket price");
        players.push(msg.sender);
        refundableAmount[msg.sender] += msg.value;
        emit TicketPurchased(msg.sender, currentRound);
    }

    function cancelLottery() external {
        require(roundEnd != 0 && block.timestamp >= roundEnd, "Round active");
        require(!roundCanceled, "Already canceled");
        require(players.length < minParticipants, "Minimum met");

        roundCanceled = true;
        outstandingRefunds = address(this).balance;
        roundEnd = 0;
        delete players;
        if (outstandingRefunds == 0) {
            roundCanceled = false;
        }

        emit RoundCanceled(currentRound, outstandingRefunds);
    }

    function refund() external {
        require(roundCanceled, "Refunds unavailable");
        uint256 amount = refundableAmount[msg.sender];
        require(amount > 0, "Nothing to refund");

        refundableAmount[msg.sender] = 0;
        outstandingRefunds -= amount;
        if (outstandingRefunds == 0) {
            roundCanceled = false;
        }

        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Refund failed");

        emit Refunded(msg.sender, amount, currentRound);
    }

    function drawWinner() external onlyOwner {
        require(roundEnd != 0 && block.timestamp >= roundEnd, "Round not ended");
        require(!roundCanceled, "Round canceled");
        require(players.length >= minParticipants, "Not enough players");

        uint256 randomIndex = uint256(
            keccak256(abi.encodePacked(block.prevrandao, block.timestamp))
        ) % players.length;

        address winner = players[randomIndex];
        roundWinners[currentRound] = winner;

        uint256 prize = address(this).balance;
        roundEnd = 0;
        for (uint256 i = 0; i < players.length; i++) {
            refundableAmount[players[i]] = 0;
        }
        delete players;

        (bool sent, ) = winner.call{value: prize}("");
        require(sent, "Transfer failed");

        emit WinnerSelected(winner, prize, currentRound);
    }

    function getPlayers() external view returns (address[] memory) {
        return players;
    }

    function getPoolSize() external view returns (uint256) {
        return address(this).balance;
    }

    function _startRound(uint256 duration, uint256 minimumParticipants) internal {
        require(roundEnd == 0 || block.timestamp > roundEnd, "Round active");
        require(!roundCanceled && outstandingRefunds == 0, "Refunds pending");
        require(duration > 0, "Invalid duration");
        require(minimumParticipants > 1, "Invalid minimum");

        delete players;
        currentRound++;
        minParticipants = minimumParticipants;
        roundEnd = block.timestamp + duration;
        emit RoundStarted(currentRound, roundEnd);
    }
}
