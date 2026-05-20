// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// @contributor sikkra-codex-lending-oracle
// @platform Private platform/session initialization text intentionally omitted.
// @runtime os=windows; arch=x64; working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell=powershell
// @date 2026-05-20T08:16:00Z

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

    uint256 public constant LIQUIDATION_THRESHOLD = 1.5e18; // 150%
    uint256 public constant PRECISION = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant LIQUIDATION_INCENTIVE_BPS = 500; // 5%
    uint256 public constant MAX_ORACLE_STALENESS = 1 hours;

    struct Position {
        uint256 collateralAmount;
        uint256 borrowedAmount;
    }

    mapping(address => Position) public positions;
    uint256 public totalDeposits;
    uint256 public totalBorrowed;
    uint256 public badDebtValue;

    event Deposited(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(
        address indexed user,
        address indexed liquidator,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 incentiveCollateral
    );
    event BadDebtSocialized(address indexed user, uint256 badDebtValue);

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

    function liquidate(address user) external {
        Position storage pos = positions[user];
        require(pos.borrowedAmount > 0, "No debt");

        (
            uint256 collateralValue,
            uint256 borrowValue,
            uint256 collateralPrice,
            uint256 borrowPrice
        ) = _positionValues(pos);
        require(collateralValue < (borrowValue * LIQUIDATION_THRESHOLD) / PRECISION, "Position healthy");

        uint256 debt = pos.borrowedAmount;
        uint256 collateral = pos.collateralAmount;
        uint256 equivalentCollateral = (borrowValue * PRECISION) / collateralPrice;
        uint256 collateralSeized = (equivalentCollateral * (BPS + LIQUIDATION_INCENTIVE_BPS)) / BPS;
        if (collateralSeized > collateral) {
            collateralSeized = collateral;
        }

        uint256 debtCoveredByCollateral = (collateralSeized * collateralPrice) / PRECISION;
        if (debtCoveredByCollateral < borrowValue) {
            uint256 shortfall = borrowValue - debtCoveredByCollateral;
            badDebtValue += shortfall;
            emit BadDebtSocialized(user, shortfall);
        }

        require(borrowPrice > 0, "Invalid borrow price");
        require(borrowToken.transferFrom(msg.sender, address(this), debt), "Transfer failed");

        pos.borrowedAmount = 0;
        pos.collateralAmount = collateral - collateralSeized;
        totalBorrowed -= debt;
        totalDeposits -= collateralSeized;

        require(collateralToken.transfer(msg.sender, collateralSeized), "Transfer failed");
        emit Liquidated(
            user,
            msg.sender,
            debt,
            collateralSeized,
            collateralSeized > equivalentCollateral ? collateralSeized - equivalentCollateral : 0
        );
    }

    function _isHealthy(address user) internal view returns (bool) {
        Position storage pos = positions[user];
        if (pos.borrowedAmount == 0) return true;

        (uint256 collateralValue, uint256 borrowValue,,) = _positionValues(pos);
        return collateralValue >= (borrowValue * LIQUIDATION_THRESHOLD) / PRECISION;
    }

    function _positionValues(Position storage pos)
        internal
        view
        returns (
            uint256 collateralValue,
            uint256 borrowValue,
            uint256 collateralPrice,
            uint256 borrowPrice
        )
    {
        collateralPrice = _validatedOraclePrice(address(collateralToken));
        borrowPrice = _validatedOraclePrice(address(borrowToken));
        collateralValue = (pos.collateralAmount * collateralPrice) / PRECISION;
        borrowValue = (pos.borrowedAmount * borrowPrice) / PRECISION;
    }

    function _validatedOraclePrice(address token) internal view returns (uint256 price) {
        price = oracle.getPrice(token);
        require(price > 0, "Invalid oracle price");

        (bool ok, bytes memory data) = address(oracle).staticcall(
            abi.encodeWithSignature("getLastUpdate(address)", token)
        );
        if (ok && data.length >= 32) {
            uint256 updatedAt = abi.decode(data, (uint256));
            require(updatedAt > 0, "Incomplete oracle round");
            require(block.timestamp - updatedAt <= MAX_ORACLE_STALENESS, "Stale oracle price");
        }

        (ok, data) = address(oracle).staticcall(
            abi.encodeWithSignature("latestRoundData(address)", token)
        );
        if (ok && data.length >= 160) {
            (uint80 roundId,, uint256 startedAt,, uint80 answeredInRound) =
                abi.decode(data, (uint80, int256, uint256, uint256, uint80));
            require(startedAt > 0 && answeredInRound >= roundId, "Incomplete oracle round");
        }
    }

    function getPosition(address user) external view returns (uint256 collateral, uint256 debt) {
        Position storage pos = positions[user];
        return (pos.collateralAmount, pos.borrowedAmount);
    }
}
