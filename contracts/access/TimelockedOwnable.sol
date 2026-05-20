// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

abstract contract TimelockedOwnable is Ownable {
    uint256 public constant OWNERSHIP_TRANSFER_DELAY = 2 days;

    address public pendingOwner;
    uint256 public ownershipTransferReadyAt;

    event OwnershipTransferQueued(address indexed currentOwner, address indexed pendingOwner, uint256 readyAt);
    event OwnershipTransferCanceled(address indexed currentOwner, address indexed pendingOwner);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function transferOwnership(address newOwner) public virtual override onlyOwner {
        require(newOwner != address(0), "TimelockedOwnable: zero address");
        pendingOwner = newOwner;
        ownershipTransferReadyAt = block.timestamp + OWNERSHIP_TRANSFER_DELAY;
        emit OwnershipTransferQueued(owner(), newOwner, ownershipTransferReadyAt);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "TimelockedOwnable: not pending owner");
        require(block.timestamp >= ownershipTransferReadyAt, "TimelockedOwnable: transfer locked");

        address newOwner = pendingOwner;
        pendingOwner = address(0);
        ownershipTransferReadyAt = 0;
        _transferOwnership(newOwner);
    }

    function cancelTransfer() external onlyOwner {
        address canceledOwner = pendingOwner;
        require(canceledOwner != address(0), "TimelockedOwnable: no pending transfer");
        pendingOwner = address(0);
        ownershipTransferReadyAt = 0;
        emit OwnershipTransferCanceled(owner(), canceledOwner);
    }
}
