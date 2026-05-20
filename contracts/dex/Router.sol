// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";

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
/// @notice Multi-hop swap router that routes trades through multiple AMM pools.
/// @dev Each hop uses a registered pool; tokens flow through the router.
contract Router {
    address public admin;

    // pool registry: tokenA => tokenB => pool address
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

    function swapExactTokensForTokens(
        address[] calldata path,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        return _swapMultiHop(path, amountIn, minAmountOut, deadline);
    }

    function swapMultiHop(
        address[] calldata path,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        return _swapMultiHop(path, amountIn, minAmountOut, deadline);
    }

    function _swapMultiHop(
        address[] calldata path,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "Deadline expired");
        require(path.length >= 2, "Path too short");
        require(amountIn > 0, "Zero input");
        require(minAmountOut > 0, "Zero min output");
        _validatePath(path);

        uint256 quotedFinalOut = _quotePath(path, amountIn);
        require(quotedFinalOut >= minAmountOut, "Slippage exceeded");
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "Transfer in failed");

        uint256 currentAmount = amountIn;

        for (uint256 i = 0; i < path.length - 1; i++) {
            address tokenIn = path[i];
            address tokenOut = path[i + 1];
            address pool = pools[tokenIn][tokenOut];
            require(pool != address(0), "No pool for pair");

            uint256 expectedHopOut = _quoteHop(tokenIn, tokenOut, currentAmount);
            uint256 hopMinAmountOut = Math.mulDiv(
                expectedHopOut,
                minAmountOut,
                quotedFinalOut,
                Math.Rounding.Ceil
            );
            require(hopMinAmountOut > 0, "Zero output");

            require(IERC20(tokenIn).approve(pool, currentAmount), "Approve failed");
            currentAmount = IAMMPool(pool).swap(tokenIn, currentAmount, hopMinAmountOut);
            require(currentAmount >= hopMinAmountOut, "Slippage exceeded");
            require(currentAmount > 0, "Zero output");
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
        return _quotePath(path, amountIn);
    }

    function _quotePath(
        address[] calldata path,
        uint256 amountIn
    ) internal view returns (uint256 estimatedOut) {
        require(path.length >= 2, "Path too short");
        require(amountIn > 0, "Zero input");
        _validatePath(path);

        uint256 currentAmount = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            currentAmount = _quoteHop(path[i], path[i + 1], currentAmount);
        }
        return currentAmount;
    }

    function _quoteHop(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (uint256 amountOut) {
        address pool = pools[tokenIn][tokenOut];
        require(pool != address(0), "No pool");

        (uint256 resA, uint256 resB) = IAMMPool(pool).getReserves();
        address tA = IAMMPool(pool).tokenA();
        address tB = IAMMPool(pool).tokenB();
        require(
            (tokenIn == tA && tokenOut == tB) || (tokenIn == tB && tokenOut == tA),
            "Pool mismatch"
        );

        (uint256 resIn, uint256 resOut) = (tokenIn == tA) ? (resA, resB) : (resB, resA);
        require(resIn > 0 && resOut > 0, "Empty pool");

        uint256 amountInWithFee = amountIn * 9970;
        amountOut = (amountInWithFee * resOut) / (resIn * 10000 + amountInWithFee);
        require(amountOut > 0, "Zero output");
    }

    function _validatePath(address[] calldata path) internal pure {
        for (uint256 i = 0; i < path.length; i++) {
            require(path[i] != address(0), "Invalid path");
            for (uint256 j = i + 1; j < path.length; j++) {
                require(path[i] != path[j], "Circular path");
            }
        }
    }

    function getPool(address tokenA, address tokenB) external view returns (address) {
        return pools[tokenA][tokenB];
    }
}
