// SPDX-License-Identifier: MIT
// @contributor openai-codex-wallet-95
// @platform Private platform/session initialization text intentionally omitted.
// @env os=windows; arch=x64; home_dir=C:\Users\Ben; working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell=powershell
// @timestamp 2026-05-20T08:07:52Z
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title YieldAggregator
/// @notice Vault that accepts deposits and allocates capital across yield strategies.
/// @dev Implements a simplified vault pattern. Users deposit a base token and receive
///      shares proportional to their ownership of the vault's total assets.
contract YieldAggregator is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Strategy {
        address target;
        uint256 allocated;
        bool active;
    }

    IERC20 public immutable asset;
    uint256 public totalShares;
    uint256 public totalDeposited;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_PRICE_DEVIATION_BPS = 500;
    mapping(address => uint256) public shares;

    Strategy[] public strategies;

    event Deposit(address indexed user, uint256 assets, uint256 sharesMinted);
    event Withdraw(address indexed user, uint256 assets, uint256 sharesBurned);
    event StrategyAdded(uint256 indexed strategyId, address target);
    event StrategyAllocated(uint256 indexed strategyId, uint256 amount);

    constructor(address _asset) Ownable(msg.sender) {
        asset = IERC20(_asset);
    }

    /// @notice Deposit tokens into the vault and receive shares.
    /// @param amount Amount of base token to deposit.
    /// @param minShares Minimum acceptable shares to receive.
    /// @return sharesMinted Number of shares issued to the depositor.
    function deposit(uint256 amount, uint256 minShares) external nonReentrant returns (uint256 sharesMinted) {
        sharesMinted = _deposit(amount, minShares);
    }

    /// @notice Backwards-compatible deposit helper with no caller-specified slippage floor.
    function deposit(uint256 amount) external nonReentrant returns (uint256 sharesMinted) {
        sharesMinted = _deposit(amount, 0);
    }

    function _deposit(uint256 amount, uint256 minShares) internal returns (uint256 sharesMinted) {
        require(amount > 0, "Vault: zero deposit");
        _requireSaneSharePrice();

        if (totalShares == 0) {
            sharesMinted = amount;
        } else {
            sharesMinted = (amount * totalShares) / totalDeposited;
        }
        require(sharesMinted > 0, "Vault: zero shares minted");
        require(sharesMinted >= minShares, "Vault: min shares");

        asset.safeTransferFrom(msg.sender, address(this), amount);
        totalShares += sharesMinted;
        totalDeposited += amount;
        shares[msg.sender] += sharesMinted;

        emit Deposit(msg.sender, amount, sharesMinted);
    }

    /// @notice Withdraw tokens by burning vault shares.
    /// @param shareAmount Number of shares to redeem.
    /// @return assetsReturned Amount of base token returned.
    function withdraw(uint256 shareAmount) external nonReentrant returns (uint256 assetsReturned) {
        require(shareAmount > 0, "Vault: zero shares");
        require(shares[msg.sender] >= shareAmount, "Vault: insufficient shares");

        assetsReturned = (shareAmount * totalDeposited) / totalShares;

        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        totalDeposited -= assetsReturned;

        asset.safeTransfer(msg.sender, assetsReturned);
        emit Withdraw(msg.sender, assetsReturned, shareAmount);
    }

    /// @notice Add a new yield strategy.
    /// @param target Address of the strategy contract.
    function addStrategy(address target) external onlyOwner {
        require(target != address(0), "Vault: zero strategy");
        strategies.push(Strategy({
            target: target,
            allocated: 0,
            active: true
        }));
        emit StrategyAdded(strategies.length - 1, target);
    }

    /// @notice Allocate vault funds to a strategy.
    /// @param strategyId Index of the strategy.
    /// @param amount Amount to allocate.
    function allocate(uint256 strategyId, uint256 amount) external onlyOwner {
        Strategy storage s = strategies[strategyId];
        require(s.active, "Vault: strategy inactive");
        require(asset.balanceOf(address(this)) >= amount, "Vault: insufficient balance");

        s.allocated += amount;
        asset.safeTransfer(s.target, amount);
        emit StrategyAllocated(strategyId, amount);
    }

    /// @notice Deactivate a strategy.
    /// @param strategyId Index of the strategy.
    function deactivateStrategy(uint256 strategyId) external onlyOwner {
        strategies[strategyId].active = false;
    }

    /// @notice Total assets under management (vault balance + allocated to strategies).
    function totalAssets() public view returns (uint256) {
        uint256 total = asset.balanceOf(address(this));
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].active) {
                total += strategies[i].allocated;
            }
        }
        return total;
    }

    /// @notice Preview shares for a given deposit amount.
    function previewDeposit(uint256 amount) external view returns (uint256) {
        if (totalShares == 0) return amount;
        return (amount * totalShares) / totalDeposited;
    }

    /// @notice Return true if observed assets are within the accepted accounting band.
    function isSharePriceSane() public view returns (bool) {
        if (totalShares == 0 || totalDeposited == 0) {
            return true;
        }

        uint256 observedAssets = totalAssets();
        uint256 maxAssets = totalDeposited + ((totalDeposited * MAX_PRICE_DEVIATION_BPS) / BPS_DENOMINATOR);
        uint256 minAssets = totalDeposited - ((totalDeposited * MAX_PRICE_DEVIATION_BPS) / BPS_DENOMINATOR);
        return observedAssets >= minAssets && observedAssets <= maxAssets;
    }

    function _requireSaneSharePrice() internal view {
        require(isSharePriceSane(), "Vault: price deviation");
    }
}
