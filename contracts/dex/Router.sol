// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAMMPool {
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) external returns (uint256);
    function getReserves() external view returns (uint256, uint256);
    function tokenA() external view returns (address);
    function tokenB() external view returns (address);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Router
/// @notice Multi-hop swap router that routes trades through multiple AMM pools
/// @dev Each hop uses a registered pool; tokens flow through the router
contract Router {
    address public admin;

    mapping(address => mapping(address => address)) public pools;

    event PoolRegistered(address tokenA, address tokenB, address pool);
    event MultiHopSwap(address indexed user, address[] path, uint256 amountIn, uint256 amountOut);

    constructor() {
        admin = msg.sender;
    }

    function registerPool(address _tokenA, address _tokenB, address _pool) external {
        require(msg.sender == admin, "Not admin");
        pools[_tokenA][_tokenB] = _pool;
        pools[_tokenB][_tokenA] = _pool;
        emit PoolRegistered(_tokenA, _tokenB, _pool);
    }

    function swapMultiHop(
        address[] calldata path,
        uint256 amountIn,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        require(path.length >= 2, "Path too short");
        require(amountIn > 0, "Zero input");
        require(minAmountOut > 0, "Zero min output");
        _validatePath(path);

        uint256[] memory quotedAmounts = _quotePath(path, amountIn);
        uint256 expectedFinalAmount = quotedAmounts[path.length - 1];
        require(expectedFinalAmount >= minAmountOut, "Quote below min output");

        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "Transfer in failed");

        uint256 currentAmount = amountIn;
        uint256 finalHopIndex = path.length - 2;

        for (uint256 i = 0; i < path.length - 1; i++) {
            address tokenIn = path[i];
            address pool = pools[tokenIn][path[i + 1]];
            require(pool != address(0), "No pool for pair");

            currentAmount = _swapHop(
                pool,
                tokenIn,
                currentAmount,
                i == finalHopIndex
                    ? minAmountOut
                    : _hopMinAmountOut(quotedAmounts[i + 1], expectedFinalAmount, minAmountOut)
            );
        }

        amountOut = currentAmount;
        require(amountOut >= minAmountOut, "Slippage exceeded");
        require(IERC20(path[path.length - 1]).transfer(msg.sender, amountOut), "Transfer out failed");

        emit MultiHopSwap(msg.sender, path, amountIn, amountOut);
    }

    function getQuote(
        address[] calldata path,
        uint256 amountIn
    ) external view returns (uint256 estimatedOut) {
        return _quotePath(path, amountIn)[path.length - 1];
    }

    function getPool(address tokenA, address tokenB) external view returns (address) {
        return pools[tokenA][tokenB];
    }

    function _validatePath(address[] calldata path) internal pure {
        for (uint256 i = 0; i < path.length; i++) {
            require(path[i] != address(0), "Zero path token");
            for (uint256 j = i + 1; j < path.length; j++) {
                require(path[i] != path[j], "Circular path");
            }
        }
    }

    function _quotePath(
        address[] calldata path,
        uint256 amountIn
    ) internal view returns (uint256[] memory amounts) {
        require(path.length >= 2, "Path too short");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        for (uint256 i = 0; i < path.length - 1; i++) {
            address pool = pools[path[i]][path[i + 1]];
            require(pool != address(0), "No pool");

            amounts[i + 1] = _getAmountOut(pool, path[i], amounts[i]);
            require(amounts[i + 1] > 0, "Zero quote output");
        }
    }

    function _getAmountOut(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) internal view returns (uint256) {
        (uint256 resA, uint256 resB) = IAMMPool(pool).getReserves();
        address tA = IAMMPool(pool).tokenA();
        (uint256 resIn, uint256 resOut) = tokenIn == tA ? (resA, resB) : (resB, resA);
        uint256 amountInWithFee = amountIn * 9970;
        return (amountInWithFee * resOut) / (resIn * 10000 + amountInWithFee);
    }

    function _hopMinAmountOut(
        uint256 quotedHopAmount,
        uint256 expectedFinalAmount,
        uint256 finalMinAmountOut
    ) internal pure returns (uint256) {
        uint256 hopMinAmountOut = (quotedHopAmount * finalMinAmountOut) / expectedFinalAmount;
        return hopMinAmountOut == 0 ? 1 : hopMinAmountOut;
    }

    function _swapHop(
        address pool,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut
    ) internal returns (uint256 amountOut) {
        require(IERC20(tokenIn).approve(pool, amountIn), "Approve failed");
        amountOut = IAMMPool(pool).swap(tokenIn, amountIn, minAmountOut);
        require(amountOut > 0, "Zero hop output");
    }
}
