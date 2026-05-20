// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract PaymentEscrow is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant AUTO_REFUND_DELAY = 30 days;

    struct Escrow {
        address payer;
        address payee;
        address token;
        uint256 amount;
        uint256 releaseTime;
        bool released;
        bool refunded;
        bool disputed;
        uint256 releasedAmount;
        uint256 refundedAmount;
    }

    mapping(uint256 => Escrow) public escrows;
    uint256 public escrowCount;

    event EscrowCreated(uint256 indexed escrowId, address indexed payer, uint256 amount);
    event EscrowReleased(uint256 indexed escrowId, address indexed payee, uint256 amount);
    event EscrowRefunded(uint256 indexed escrowId, address indexed payer, uint256 amount);
    event EscrowDisputed(uint256 indexed escrowId, address indexed raisedBy);
    event DisputeResolved(
        uint256 indexed escrowId,
        uint256 payeeAmount,
        uint256 payerRefundAmount
    );

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

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        uint256 escrowId = escrowCount++;
        escrows[escrowId] = Escrow({
            payer: msg.sender,
            payee: payee,
            token: token,
            amount: amount,
            releaseTime: block.timestamp + lockDuration,
            released: false,
            refunded: false,
            disputed: false,
            releasedAmount: 0,
            refundedAmount: 0
        });

        emit EscrowCreated(escrowId, msg.sender, amount);
        return escrowId;
    }

    function releaseEscrow(uint256 escrowId) external {
        _releaseEscrow(escrowId, remainingAmount(escrowId));
    }

    function releaseEscrow(uint256 escrowId, uint256 amount) external {
        _releaseEscrow(escrowId, amount);
    }

    function refundEscrow(uint256 escrowId) external {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.payer != address(0), "Escrow not found");
        require(!escrow.disputed, "Escrow disputed");
        require(block.timestamp > escrow.releaseTime, "Lock not expired");
        require(msg.sender == escrow.payer, "Not payer");

        _refundRemaining(escrowId);
    }

    function dispute(uint256 escrowId) external {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.payer != address(0), "Escrow not found");
        require(!_isSettled(escrow), "Already settled");
        require(!escrow.disputed, "Already disputed");
        require(msg.sender == escrow.payer || msg.sender == escrow.payee, "Not participant");

        escrow.disputed = true;
        emit EscrowDisputed(escrowId, msg.sender);
    }

    function resolveDispute(uint256 escrowId, uint256 payeeAmount) external onlyOwner {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.payer != address(0), "Escrow not found");
        require(escrow.disputed, "Escrow not disputed");

        uint256 remaining = _remainingAmount(escrow);
        require(payeeAmount <= remaining, "Amount exceeds remaining");

        uint256 payerRefundAmount = remaining - payeeAmount;
        escrow.releasedAmount += payeeAmount;
        escrow.refundedAmount += payerRefundAmount;
        escrow.released = true;
        escrow.refunded = true;
        escrow.disputed = false;

        if (payeeAmount > 0) {
            IERC20(escrow.token).safeTransfer(escrow.payee, payeeAmount);
        }
        if (payerRefundAmount > 0) {
            IERC20(escrow.token).safeTransfer(escrow.payer, payerRefundAmount);
        }

        emit DisputeResolved(escrowId, payeeAmount, payerRefundAmount);
    }

    function refundExpiredEscrow(uint256 escrowId) external {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.payer != address(0), "Escrow not found");
        require(block.timestamp >= escrow.releaseTime + AUTO_REFUND_DELAY, "Timeout not reached");

        _refundRemaining(escrowId);
    }

    function remainingAmount(uint256 escrowId) public view returns (uint256) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.payer != address(0), "Escrow not found");
        return _remainingAmount(escrow);
    }

    function _releaseEscrow(uint256 escrowId, uint256 amount) private {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.payer != address(0), "Escrow not found");
        require(!_isSettled(escrow), "Already settled");
        require(!escrow.disputed, "Escrow disputed");
        require(msg.sender == escrow.payer || msg.sender == owner(), "Not authorized");
        require(amount > 0 && amount <= _remainingAmount(escrow), "Invalid amount");

        escrow.releasedAmount += amount;
        if (_remainingAmount(escrow) == 0) {
            escrow.released = true;
        }

        IERC20(escrow.token).safeTransfer(escrow.payee, amount);
        emit EscrowReleased(escrowId, escrow.payee, amount);
    }

    function _refundRemaining(uint256 escrowId) private {
        Escrow storage escrow = escrows[escrowId];
        require(!_isSettled(escrow), "Already settled");

        uint256 refundAmount = _remainingAmount(escrow);
        require(refundAmount > 0, "Nothing to refund");

        escrow.refundedAmount += refundAmount;
        escrow.refunded = true;
        escrow.disputed = false;

        IERC20(escrow.token).safeTransfer(escrow.payer, refundAmount);
        emit EscrowRefunded(escrowId, escrow.payer, refundAmount);
    }

    function _remainingAmount(Escrow storage escrow) private view returns (uint256) {
        return escrow.amount - escrow.releasedAmount - escrow.refundedAmount;
    }

    function _isSettled(Escrow storage escrow) private view returns (bool) {
        return _remainingAmount(escrow) == 0;
    }
}
