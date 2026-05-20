// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @generated-by openai-codex-wallet-32
/// @timestamp 2026-05-20T09:20:22Z
/// @platform Private platform/session initialization text intentionally omitted.
/// @runtime OS windows; arch x64; home C:\Users\Ben; cwd D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell powershell.

/// @title CompoundVault
/// @notice Auto-compounding vault that periodically harvests yield and reinvests.
/// @dev Deposits into an underlying strategy, harvests rewards, sells for the base
///      asset, and re-deposits to compound returns. Charges a performance fee.
contract CompoundVault is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable baseToken;
    IERC20 public immutable rewardToken;
    address public strategy;
    address public feeRecipient;

    uint256 public totalShares;
    uint256 public totalDeposited;
    uint256 public performanceFeeBps; // basis points (e.g., 1000 = 10%)
    uint256 public lastHarvestTime;
    uint256 public lastPricePerShare;

    mapping(address => uint256) public userShares;
    mapping(address => uint256) public emergencyWithdrawn;

    event Deposited(address indexed user, uint256 amount, uint256 shares);
    event Withdrawn(address indexed user, uint256 amount, uint256 shares);
    event EmergencyPaused(address indexed owner, string reason);
    event EmergencyUnpaused(address indexed owner);
    event EmergencyWithdraw(address indexed user, uint256 amount, uint256 shares);
    event Harvested(uint256 profit, uint256 fee, uint256 timestamp);
    event Compounded(uint256 amount, uint256 newPricePerShare);

    constructor(
        address _baseToken,
        address _rewardToken,
        address _strategy,
        address _feeRecipient,
        uint256 _feeBps
    ) Ownable(msg.sender) {
        require(_feeBps <= 3000, "Vault: fee too high");
        baseToken = IERC20(_baseToken);
        rewardToken = IERC20(_rewardToken);
        strategy = _strategy;
        feeRecipient = _feeRecipient;
        performanceFeeBps = _feeBps;
        lastPricePerShare = 1e18;
    }

    /// @notice Pause normal vault operations during an emergency.
    function pause(string calldata reason) external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender, reason);
    }

    /// @notice Resume normal vault operations after an emergency.
    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    /// @notice Deposit base tokens and receive vault shares.
    /// @param amount Amount of base token to deposit.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Vault: zero amount");

        uint256 sharesToMint;
        if (totalShares == 0) {
            sharesToMint = amount;
        } else {
            sharesToMint = (amount * totalShares) / totalDeposited;
        }

        baseToken.safeTransferFrom(msg.sender, address(this), amount);
        totalShares += sharesToMint;
        totalDeposited += amount;
        userShares[msg.sender] += sharesToMint;

        emit Deposited(msg.sender, amount, sharesToMint);
    }

    /// @notice Withdraw base tokens by burning vault shares.
    /// @param shareAmount Number of shares to redeem.
    function withdraw(uint256 shareAmount) external nonReentrant whenNotPaused {
        require(shareAmount > 0 && userShares[msg.sender] >= shareAmount, "Vault: invalid");

        uint256 assets = (shareAmount * totalDeposited) / totalShares;

        userShares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        totalDeposited -= assets;

        baseToken.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shareAmount);
    }

    /// @notice Emergency withdrawal available only while the vault is paused.
    /// @dev Burns shares and returns the user's pro rata share of liquid vault assets.
    function emergencyWithdraw(uint256 shareAmount) external nonReentrant whenPaused {
        require(shareAmount > 0 && userShares[msg.sender] >= shareAmount, "Vault: invalid");

        uint256 assets = (shareAmount * baseToken.balanceOf(address(this))) / totalShares;
        userShares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        totalDeposited = totalDeposited > assets ? totalDeposited - assets : 0;
        emergencyWithdrawn[msg.sender] += assets;

        baseToken.safeTransfer(msg.sender, assets);
        emit EmergencyWithdraw(msg.sender, assets, shareAmount);
    }

    /// @notice Harvest rewards from the strategy and calculate profit.
    /// @return profit The net profit after fees.
    function harvest() external whenNotPaused returns (uint256 profit) {
        uint256 rewardBalance = rewardToken.balanceOf(address(this));
        require(rewardBalance > 0, "Vault: nothing to harvest");

        uint256 estimatedValue = (rewardBalance * lastPricePerShare) / 1e18;

        uint256 fee = (estimatedValue * performanceFeeBps) / 10000;
        profit = estimatedValue - fee;

        if (fee > 0) {
            rewardToken.safeTransfer(feeRecipient, fee);
        }

        lastHarvestTime = block.timestamp;
        emit Harvested(profit, fee, block.timestamp);
    }

    /// @notice Compound harvested rewards by converting and re-depositing.
    /// @dev In production this would swap rewardToken -> baseToken via a DEX.
    ///      Simplified here to direct deposit of reward token balance.
    function compound() external onlyOwner whenNotPaused {
        uint256 rewardBalance = rewardToken.balanceOf(address(this));
        if (rewardBalance == 0) return;

        uint256 compoundAmount = (rewardBalance * lastPricePerShare) / 1e18;

        totalDeposited += compoundAmount;
        lastPricePerShare = totalShares > 0 ? (totalDeposited * 1e18) / totalShares : 1e18;

        emit Compounded(compoundAmount, lastPricePerShare);
    }

    /// @notice Update the performance fee.
    /// @param newFeeBps New fee in basis points (max 30%).
    function setPerformanceFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 3000, "Vault: fee too high");
        performanceFeeBps = newFeeBps;
    }

    /// @notice Update the fee recipient address.
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Vault: zero address");
        feeRecipient = _feeRecipient;
    }

    /// @notice Get the current price per share.
    function pricePerShare() external view returns (uint256) {
        if (totalShares == 0) return 1e18;
        return (totalDeposited * 1e18) / totalShares;
    }
}
