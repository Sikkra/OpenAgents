// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFlashLoanReceiver {
    function executeOperation(
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external returns (bool);
}

/// @title FlashLoan
/// @notice Single-token flash-loan pool with minimum fees and drainage protection.
contract FlashLoan is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant FEE_BPS = 5;
    uint256 public constant MAX_LOAN_BPS = 5_000;

    IERC20 public immutable token;
    uint256 public accountedLiquidity;

    event Deposited(address indexed sender, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);
    event FlashLoanExecuted(address indexed receiver, uint256 amount, uint256 fee);
    event AccountedLiquiditySynced(uint256 previousLiquidity, uint256 newLiquidity);

    constructor(address token_) Ownable(msg.sender) {
        require(token_ != address(0), "FlashLoan: zero token");
        token = IERC20(token_);
    }

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "FlashLoan: zero deposit");

        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - beforeBalance;
        require(received > 0, "FlashLoan: no tokens received");

        accountedLiquidity += received;
        emit Deposited(msg.sender, received);
    }

    function withdraw(uint256 amount, address recipient) external onlyOwner nonReentrant {
        require(recipient != address(0), "FlashLoan: zero recipient");
        require(amount <= accountedLiquidity, "FlashLoan: insufficient liquidity");

        accountedLiquidity -= amount;
        token.safeTransfer(recipient, amount);
        emit Withdrawn(recipient, amount);
    }

    function flashLoan(
        IFlashLoanReceiver receiver,
        uint256 amount,
        bytes calldata data
    ) external whenNotPaused nonReentrant {
        require(address(receiver) != address(0), "FlashLoan: zero receiver");
        require(amount > 0, "FlashLoan: zero amount");
        require(amount <= maxFlashLoan(), "FlashLoan: exceeds max loan");

        uint256 balanceBefore = token.balanceOf(address(this));
        require(balanceBefore >= accountedLiquidity, "FlashLoan: liquidity mismatch");

        uint256 fee = flashFee(amount);
        token.safeTransfer(address(receiver), amount);
        require(
            receiver.executeOperation(address(token), amount, fee, data),
            "FlashLoan: callback failed"
        );

        uint256 expectedBalance = balanceBefore + fee;
        require(token.balanceOf(address(this)) >= expectedBalance, "FlashLoan: not repaid");

        accountedLiquidity += fee;
        emit FlashLoanExecuted(address(receiver), amount, fee);
    }

    function flashFee(uint256 amount) public pure returns (uint256) {
        require(amount > 0, "FlashLoan: zero amount");
        uint256 fee = (amount * FEE_BPS + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
        return fee == 0 ? 1 : fee;
    }

    function maxFlashLoan() public view returns (uint256) {
        return (accountedLiquidity * MAX_LOAN_BPS) / BPS_DENOMINATOR;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function syncAccountedLiquidity() external onlyOwner {
        uint256 previousLiquidity = accountedLiquidity;
        accountedLiquidity = token.balanceOf(address(this));
        emit AccountedLiquiditySynced(previousLiquidity, accountedLiquidity);
    }
}
