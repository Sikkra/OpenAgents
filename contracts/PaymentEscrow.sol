// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract PaymentEscrow is Ownable {
    uint256 public constant REFUND_TIMEOUT = 30 days;

    struct Escrow {
        address payer;
        address payee;
        address token;
        uint256 amount;
        uint256 releasedAmount;
        uint256 releaseTime;
        uint256 createdAt;
        bool released;
        bool refunded;
        bool disputed;
    }

    mapping(uint256 => Escrow) public escrows;
    uint256 public escrowCount;

    event EscrowCreated(uint256 indexed escrowId, address indexed payer, uint256 amount);
    event EscrowReleased(uint256 indexed escrowId, address indexed payee, uint256 amount);
    event EscrowRefunded(uint256 indexed escrowId, address indexed payer, uint256 amount);
    event EscrowDisputed(uint256 indexed escrowId, address indexed reporter);
    event DisputeResolved(uint256 indexed escrowId, uint256 payeeAmount, uint256 refundAmount);

    constructor() Ownable(msg.sender) {}

    function createEscrow(
        address payee,
        address token,
        uint256 amount,
        uint256 lockDuration
    ) external returns (uint256) {
        require(payee != address(0), "Invalid payee");
        require(token != address(0), "Invalid token");
        require(amount > 0, "Amount must be > 0");

        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "Transfer failed");

        uint256 escrowId = escrowCount++;
        escrows[escrowId] = Escrow({
            payer: msg.sender,
            payee: payee,
            token: token,
            amount: amount,
            releasedAmount: 0,
            releaseTime: block.timestamp + lockDuration,
            createdAt: block.timestamp,
            released: false,
            refunded: false,
            disputed: false
        });

        emit EscrowCreated(escrowId, msg.sender, amount);
        return escrowId;
    }

    function releaseEscrow(uint256 escrowId) external {
        Escrow storage escrow = escrows[escrowId];
        _releaseAmount(escrowId, escrow.amount - escrow.releasedAmount);
    }

    function releasePartial(uint256 escrowId, uint256 amount) external {
        _releaseAmount(escrowId, amount);
    }

    function dispute(uint256 escrowId) external {
        Escrow storage escrow = escrows[escrowId];
        require(!_isSettled(escrow), "Already settled");
        require(msg.sender == escrow.payer || msg.sender == escrow.payee, "Not party");
        escrow.disputed = true;
        emit EscrowDisputed(escrowId, msg.sender);
    }

    function resolveDispute(uint256 escrowId, uint256 payeeAmount) external onlyOwner {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.disputed, "Not disputed");
        require(!_isSettled(escrow), "Already settled");

        uint256 remaining = escrow.amount - escrow.releasedAmount;
        require(payeeAmount <= remaining, "Amount exceeds remaining");
        uint256 refundAmount = remaining - payeeAmount;

        escrow.releasedAmount += payeeAmount;
        escrow.released = true;
        escrow.refunded = true;
        escrow.disputed = false;

        if (payeeAmount > 0) {
            require(IERC20(escrow.token).transfer(escrow.payee, payeeAmount), "Payee transfer failed");
            emit EscrowReleased(escrowId, escrow.payee, payeeAmount);
        }
        if (refundAmount > 0) {
            require(IERC20(escrow.token).transfer(escrow.payer, refundAmount), "Refund transfer failed");
            emit EscrowRefunded(escrowId, escrow.payer, refundAmount);
        }

        emit DisputeResolved(escrowId, payeeAmount, refundAmount);
    }

    function refundEscrow(uint256 escrowId) external {
        Escrow storage escrow = escrows[escrowId];
        require(!_isSettled(escrow), "Already settled");
        require(!escrow.disputed, "Escrow disputed");
        require(block.timestamp >= escrow.releaseTime + REFUND_TIMEOUT, "Timeout not reached");

        uint256 refundAmount = escrow.amount - escrow.releasedAmount;
        escrow.refunded = true;

        require(IERC20(escrow.token).transfer(escrow.payer, refundAmount), "Refund transfer failed");
        emit EscrowRefunded(escrowId, escrow.payer, refundAmount);
    }

    function _releaseAmount(uint256 escrowId, uint256 amount) internal {
        Escrow storage escrow = escrows[escrowId];
        require(!_isSettled(escrow), "Already settled");
        require(!escrow.disputed, "Escrow disputed");
        require(msg.sender == escrow.payer || msg.sender == owner(), "Not authorized");
        require(amount > 0, "Zero release");
        require(escrow.releasedAmount + amount <= escrow.amount, "Amount exceeds remaining");

        escrow.releasedAmount += amount;
        if (escrow.releasedAmount == escrow.amount) {
            escrow.released = true;
        }

        require(IERC20(escrow.token).transfer(escrow.payee, amount), "Payee transfer failed");
        emit EscrowReleased(escrowId, escrow.payee, amount);
    }

    function _isSettled(Escrow storage escrow) internal view returns (bool) {
        return escrow.released || escrow.refunded;
    }
}
