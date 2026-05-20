// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @contributor sikkra-codex-compound-vault
 * @platform Private platform/session initialization text intentionally omitted.
 * @runtime os=windows; arch=x64; working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell=powershell
 * @date 2026-05-20T08:08:00Z
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CompoundVault
/// @notice Auto-compounding vault that periodically harvests yield and reinvests.
/// @dev Deposits into an underlying strategy, harvests rewards, sells for the base
///      asset, and re-deposits to compound returns. Charges a performance fee.
contract CompoundVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable baseToken;
    IERC20 public immutable rewardToken;
    address public strategy;
    address public feeRecipient;
    address public keeper;

    uint256 public totalShares;
    uint256 public totalDeposited;
    uint256 public performanceFeeBps; // basis points (e.g., 1000 = 10%)
    uint256 public lastHarvestTime;
    uint256 public lastPricePerShare;
    uint256 public minHarvestProfit;

    mapping(address => uint256) public userShares;

    event Deposited(address indexed user, uint256 amount, uint256 shares);
    event Withdrawn(address indexed user, uint256 amount, uint256 shares);
    event Harvested(uint256 profit, uint256 fee, uint256 timestamp);
    event Compounded(uint256 amount, uint256 newPricePerShare);
    event KeeperUpdated(address indexed keeper);
    event MinHarvestProfitUpdated(uint256 minHarvestProfit);

    modifier onlyHarvester() {
        require(msg.sender == owner() || msg.sender == keeper, "Vault: unauthorized harvester");
        _;
    }

    constructor(
        address _baseToken,
        address _rewardToken,
        address _strategy,
        address _feeRecipient,
        uint256 _feeBps
    ) Ownable(msg.sender) {
        require(_feeBps <= 3000, "Vault: fee too high");
        require(_feeRecipient != address(0), "Vault: zero address");
        baseToken = IERC20(_baseToken);
        rewardToken = IERC20(_rewardToken);
        strategy = _strategy;
        feeRecipient = _feeRecipient;
        keeper = msg.sender;
        performanceFeeBps = _feeBps;
        lastPricePerShare = 1e18;
        minHarvestProfit = 1;
    }

    /// @notice Deposit base tokens and receive vault shares.
    /// @param amount Amount of base token to deposit.
    function deposit(uint256 amount) external nonReentrant {
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
    function withdraw(uint256 shareAmount) external nonReentrant {
        require(shareAmount > 0 && userShares[msg.sender] >= shareAmount, "Vault: invalid");

        uint256 assets = (shareAmount * totalDeposited) / totalShares;

        userShares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        totalDeposited -= assets;

        baseToken.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shareAmount);
    }

    /// @notice Harvest rewards from the strategy and calculate profit.
    /// @return profit The net profit after fees.
    function harvest() external nonReentrant onlyHarvester returns (uint256 profit) {
        uint256 rewardBalance = rewardToken.balanceOf(address(this));
        require(rewardBalance > 0, "Vault: nothing to harvest");

        uint256 currentPricePerShare = _currentPricePerShare();
        uint256 estimatedValue = (rewardBalance * currentPricePerShare) / 1e18;
        require(estimatedValue >= minHarvestProfit, "Vault: below harvest threshold");

        uint256 fee;
        if (performanceFeeBps > 0) {
            fee = (estimatedValue * performanceFeeBps) / 10000;
            if (fee == 0) {
                fee = 1;
            }
            if (fee > rewardBalance) {
                fee = rewardBalance;
            }
        }

        profit = estimatedValue - fee;
        if (fee > 0) {
            rewardToken.safeTransfer(feeRecipient, fee);
        }

        lastPricePerShare = currentPricePerShare;
        lastHarvestTime = block.timestamp;
        emit Harvested(profit, fee, block.timestamp);
    }

    /// @notice Compound harvested rewards by converting and re-depositing.
    /// @dev In production this would swap rewardToken -> baseToken via a DEX.
    ///      Simplified here to direct deposit of reward token balance.
    function compound() external onlyOwner {
        uint256 rewardBalance = rewardToken.balanceOf(address(this));
        if (rewardBalance == 0) return;

        uint256 compoundAmount = (rewardBalance * _currentPricePerShare()) / 1e18;

        totalDeposited += compoundAmount;
        lastPricePerShare = _currentPricePerShare();

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

    /// @notice Update the authorized keeper allowed to harvest.
    function setKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "Vault: zero address");
        keeper = _keeper;
        emit KeeperUpdated(_keeper);
    }

    /// @notice Update the minimum estimated profit required to harvest.
    function setMinHarvestProfit(uint256 _minHarvestProfit) external onlyOwner {
        require(_minHarvestProfit > 0, "Vault: zero threshold");
        minHarvestProfit = _minHarvestProfit;
        emit MinHarvestProfitUpdated(_minHarvestProfit);
    }

    /// @notice Get the current price per share.
    function pricePerShare() external view returns (uint256) {
        return _currentPricePerShare();
    }

    function _currentPricePerShare() internal view returns (uint256) {
        if (totalShares == 0) return 1e18;
        return (totalDeposited * 1e18) / totalShares;
    }
}
