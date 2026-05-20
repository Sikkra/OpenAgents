// SPDX-License-Identifier: MIT
// @contributor-info openai-codex-wallet-141
// @platform Private platform/session initialization text intentionally omitted.
// @env os=windows; arch=x64; home_dir=C:\Users\Ben; working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell=powershell
// @timestamp 2026-05-20T08:24:50Z
pragma solidity ^0.8.20;

interface IPriceFeed {
    function getPrice(address token) external view returns (uint256);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title LendingPool
/// @notice Collateralized lending pool supporting deposit, borrow, repay, and liquidation
/// @dev Uses an external price feed oracle for collateral valuation
contract LendingPool {
    IPriceFeed public oracle;
    IERC20 public collateralToken;
    IERC20 public borrowToken;

    // BUG: Liquidation threshold hardcoded to 150% (1.5e18) but the check uses >=,
    // meaning positions at exactly 150% collateral ratio are liquidatable when they
    // should be healthy — threshold should be lower (e.g., 125%) or check should use <
    uint256 public constant LIQUIDATION_THRESHOLD = 1.5e18; // 150%
    uint256 public constant PRECISION = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant FLASH_LOAN_FEE_BPS = 9; // 0.09%

    struct Position {
        uint256 collateralAmount;
        uint256 borrowedAmount;
    }

    mapping(address => Position) public positions;
    uint256 public totalDeposits;
    uint256 public totalBorrowed;
    uint256 public protocolCollateralReserves;
    uint256 public flashLoanFeesCollected;

    event Deposited(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debtRepaid);
    event FlashLiquidated(
        address indexed user,
        address indexed liquidator,
        uint256 debtRepaid,
        uint256 feePaid,
        uint256 collateralToProtocol,
        uint256 profitCollateral
    );

    constructor(address _oracle, address _collateralToken, address _borrowToken) {
        oracle = IPriceFeed(_oracle);
        collateralToken = IERC20(_collateralToken);
        borrowToken = IERC20(_borrowToken);
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "Zero amount");
        require(collateralToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        positions[msg.sender].collateralAmount += amount;
        totalDeposits += amount;
        emit Deposited(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        require(amount > 0, "Zero amount");
        positions[msg.sender].borrowedAmount += amount;
        totalBorrowed += amount;

        require(_isHealthy(msg.sender), "Undercollateralized");
        require(borrowToken.transfer(msg.sender, amount), "Transfer failed");
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        Position storage pos = positions[msg.sender];
        require(amount <= pos.borrowedAmount, "Repay exceeds debt");
        require(borrowToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        pos.borrowedAmount -= amount;
        totalBorrowed -= amount;
        emit Repaid(msg.sender, amount);
    }

    // BUG: No bad debt handling — if collateral value drops below debt value,
    // liquidator repays debt but received collateral is worth less, creating a
    // protocol loss that is never socialized or covered by a reserve
    function liquidate(address user) external {
        require(!_isHealthy(user), "Position healthy");

        Position storage pos = positions[user];
        uint256 debt = pos.borrowedAmount;
        uint256 collateral = pos.collateralAmount;

        require(borrowToken.transferFrom(msg.sender, address(this), debt), "Transfer failed");

        pos.borrowedAmount = 0;
        pos.collateralAmount = 0;
        totalBorrowed -= debt;
        totalDeposits -= collateral;

        require(collateralToken.transfer(msg.sender, collateral), "Transfer failed");
        emit Liquidated(user, msg.sender, debt);
    }

    /// @notice Atomically liquidate an underwater borrower without liquidator upfront capital.
    /// @param user Borrower to liquidate.
    /// @param minProfitCollateral Minimum surplus collateral the liquidator is willing to accept.
    /// @return profitCollateral Surplus collateral transferred to the liquidator.
    function flashLiquidate(
        address user,
        uint256 minProfitCollateral
    ) external returns (uint256 profitCollateral) {
        require(!_isHealthy(user), "Position healthy");

        Position storage pos = positions[user];
        uint256 debt = pos.borrowedAmount;
        uint256 collateral = pos.collateralAmount;
        require(debt > 0, "No debt");

        uint256 fee = flashLoanFee(debt);
        uint256 collateralToProtocol = _collateralForBorrowAmount(debt + fee);
        require(collateral > collateralToProtocol, "Unprofitable liquidation");

        profitCollateral = collateral - collateralToProtocol;
        require(profitCollateral >= minProfitCollateral, "Insufficient profit");

        pos.borrowedAmount = 0;
        pos.collateralAmount = 0;
        totalBorrowed -= debt;
        totalDeposits -= collateral;
        protocolCollateralReserves += collateralToProtocol;
        flashLoanFeesCollected += fee;

        require(collateralToken.transfer(msg.sender, profitCollateral), "Transfer failed");
        emit FlashLiquidated(user, msg.sender, debt, fee, collateralToProtocol, profitCollateral);
    }

    /// @notice Quote a flash liquidation using current oracle prices.
    function quoteFlashLiquidation(
        address user
    )
        external
        view
        returns (
            uint256 debt,
            uint256 fee,
            uint256 collateralToProtocol,
            uint256 profitCollateral,
            bool profitable
        )
    {
        Position storage pos = positions[user];
        debt = pos.borrowedAmount;
        if (debt == 0) {
            return (0, 0, 0, 0, false);
        }
        fee = flashLoanFee(debt);
        collateralToProtocol = _collateralForBorrowAmount(debt + fee);
        if (!_isHealthy(user) && pos.collateralAmount > collateralToProtocol) {
            profitCollateral = pos.collateralAmount - collateralToProtocol;
            profitable = true;
        }
    }

    function flashLoanFee(uint256 amount) public pure returns (uint256) {
        return (amount * FLASH_LOAN_FEE_BPS) / BPS_DENOMINATOR;
    }

    function _isHealthy(address user) internal view returns (bool) {
        Position storage pos = positions[user];
        if (pos.borrowedAmount == 0) return true;

        // BUG: Oracle price not validated — getPrice could return 0 or stale data,
        // making all positions appear healthy (0 * anything = 0) or unhealthy
        uint256 collateralPrice = oracle.getPrice(address(collateralToken));
        uint256 borrowPrice = oracle.getPrice(address(borrowToken));

        uint256 collateralValue = (pos.collateralAmount * collateralPrice) / PRECISION;
        uint256 borrowValue = (pos.borrowedAmount * borrowPrice) / PRECISION;

        return collateralValue >= (borrowValue * LIQUIDATION_THRESHOLD) / PRECISION;
    }

    function _collateralForBorrowAmount(uint256 borrowAmount) internal view returns (uint256) {
        uint256 collateralPrice = oracle.getPrice(address(collateralToken));
        uint256 borrowPrice = oracle.getPrice(address(borrowToken));
        require(collateralPrice > 0 && borrowPrice > 0, "Invalid oracle price");

        return ((borrowAmount * borrowPrice) + collateralPrice - 1) / collateralPrice;
    }

    function getPosition(address user) external view returns (uint256 collateral, uint256 debt) {
        Position storage pos = positions[user];
        return (pos.collateralAmount, pos.borrowedAmount);
    }
}
