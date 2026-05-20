// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title YieldAggregator
/// @notice Vault that accepts deposits and allocates capital across yield strategies.
/// @custom:contributor-info openai-codex-wallet-134; private platform/session initialization text intentionally omitted; runtime windows x64 powershell cwd D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents.
/// @dev Implements a simplified vault pattern. Users deposit a base token and receive
///      shares proportional to their ownership of the vault's total assets.
contract YieldAggregator is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Strategy {
        address target;
        uint256 allocated;
        uint256 maxAllocationBps;
        bool active;
    }

    uint256 public constant BPS = 10_000;
    IERC20 public immutable asset;
    uint256 public totalShares;
    uint256 public totalDeposited;
    mapping(address => uint256) public shares;

    Strategy[] public strategies;

    event Deposit(address indexed user, uint256 assets, uint256 sharesMinted);
    event Withdraw(address indexed user, uint256 assets, uint256 sharesBurned);
    event StrategyAdded(uint256 indexed strategyId, address target, uint256 maxAllocationBps);
    event StrategyAllocated(uint256 indexed strategyId, uint256 amount);
    event StrategyAllocationCapUpdated(uint256 indexed strategyId, uint256 maxAllocationBps);

    constructor(address _asset) Ownable(msg.sender) {
        asset = IERC20(_asset);
    }

    /// @notice Deposit tokens into the vault and receive shares.
    /// @param amount Amount of base token to deposit.
    /// @return sharesMinted Number of shares issued to the depositor.
    // BUG: No slippage check on deposit - the share price can be manipulated via
    // donation attacks (sending tokens directly to the vault) between the user's
    // approval and deposit, causing them to receive far fewer shares than expected.
    function deposit(uint256 amount) external nonReentrant returns (uint256 sharesMinted) {
        require(amount > 0, "Vault: zero deposit");

        if (totalShares == 0) {
            sharesMinted = amount;
        } else {
            sharesMinted = (amount * totalShares) / totalAssets();
        }

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

        // BUG: Uses balanceOf instead of internal accounting (totalDeposited + strategy gains).
        // If tokens are donated directly to the vault or a strategy returns funds outside
        // the normal flow, this inflates the withdrawal amount, allowing early withdrawers
        // to drain more than their share at the expense of later users.
        assetsReturned = (shareAmount * asset.balanceOf(address(this))) / totalShares;

        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;

        asset.safeTransfer(msg.sender, assetsReturned);
        emit Withdraw(msg.sender, assetsReturned, shareAmount);
    }

    /// @notice Add a new yield strategy.
    /// @param target Address of the strategy contract.
    // BUG: Strategy target can be zero address - allocating funds to address(0)
    // would burn them permanently via the external call.
    function addStrategy(address target) external onlyOwner {
        _addStrategy(target, BPS);
    }

    function addStrategy(address target, uint256 maxAllocationBps) external onlyOwner {
        _addStrategy(target, maxAllocationBps);
    }

    function _addStrategy(address target, uint256 maxAllocationBps) internal {
        require(target != address(0), "Vault: zero strategy");
        require(maxAllocationBps > 0 && maxAllocationBps <= BPS, "Vault: invalid allocation cap");
        strategies.push(Strategy({
            target: target,
            allocated: 0,
            maxAllocationBps: maxAllocationBps,
            active: true
        }));
        emit StrategyAdded(strategies.length - 1, target, maxAllocationBps);
    }

    function setStrategyMaxAllocation(uint256 strategyId, uint256 maxAllocationBps) external onlyOwner {
        require(maxAllocationBps > 0 && maxAllocationBps <= BPS, "Vault: invalid allocation cap");
        strategies[strategyId].maxAllocationBps = maxAllocationBps;
        emit StrategyAllocationCapUpdated(strategyId, maxAllocationBps);
    }

    /// @notice Allocate vault funds to a strategy.
    /// @param strategyId Index of the strategy.
    /// @param amount Amount to allocate.
    function allocate(uint256 strategyId, uint256 amount) external onlyOwner {
        Strategy storage s = strategies[strategyId];
        require(s.active, "Vault: strategy inactive");
        require(asset.balanceOf(address(this)) >= amount, "Vault: insufficient balance");
        require(_withinStrategyCap(s, amount), "Vault: allocation cap exceeded");

        s.allocated += amount;
        asset.safeTransfer(s.target, amount);
        emit StrategyAllocated(strategyId, amount);
    }

    function rebalance() external onlyOwner {
        uint256 idle = asset.balanceOf(address(this));
        uint256 assets = totalAssets();

        for (uint256 i = 0; i < strategies.length && idle > 0; i++) {
            Strategy storage s = strategies[i];
            if (!s.active) continue;

            uint256 maxAllocation = (assets * s.maxAllocationBps) / BPS;
            if (s.allocated >= maxAllocation) continue;

            uint256 amount = maxAllocation - s.allocated;
            if (amount > idle) {
                amount = idle;
            }

            s.allocated += amount;
            idle -= amount;
            asset.safeTransfer(s.target, amount);
            emit StrategyAllocated(i, amount);
        }
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

    function strategyAllocationBps(uint256 strategyId) external view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets == 0) return 0;
        return (strategies[strategyId].allocated * BPS) / assets;
    }

    function _withinStrategyCap(Strategy storage strategy, uint256 additionalAmount) internal view returns (bool) {
        uint256 assets = totalAssets();
        if (assets == 0) return false;
        return strategy.allocated + additionalAmount <= (assets * strategy.maxAllocationBps) / BPS;
    }

    /// @notice Preview shares for a given deposit amount.
    function previewDeposit(uint256 amount) external view returns (uint256) {
        if (totalShares == 0) return amount;
        return (amount * totalShares) / totalAssets();
    }
}
