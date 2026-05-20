// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../lottery/FlashLoan.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract FlashLoanReceiverMock is IFlashLoanReceiver {
    using SafeERC20 for IERC20;

    IERC20 public immutable repaymentToken;
    bool public repay = true;
    bool public called;
    uint256 public lastFee;

    constructor(address token_) {
        repaymentToken = IERC20(token_);
    }

    function setRepay(bool repay_) external {
        repay = repay_;
    }

    function executeOperation(
        address,
        uint256 amount,
        uint256 fee,
        bytes calldata
    ) external returns (bool) {
        called = true;
        lastFee = fee;
        if (repay) {
            repaymentToken.safeTransfer(msg.sender, amount + fee);
        }
        return true;
    }
}
