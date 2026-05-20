// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMockRouterToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract MockRouterPool {
    address public tokenA;
    address public tokenB;
    uint256 public reserveA;
    uint256 public reserveB;
    uint256 public lastMinAmountOut;

    constructor(address _tokenA, address _tokenB, uint256 _reserveA, uint256 _reserveB) {
        tokenA = _tokenA;
        tokenB = _tokenB;
        reserveA = _reserveA;
        reserveB = _reserveB;
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut) {
        require(tokenIn == tokenA || tokenIn == tokenB, "Invalid token");
        require(amountIn > 0, "Zero input");

        bool isA = tokenIn == tokenA;
        (uint256 resIn, uint256 resOut) = isA ? (reserveA, reserveB) : (reserveB, reserveA);
        uint256 amountInWithFee = amountIn * 9970;
        amountOut = (amountInWithFee * resOut) / (resIn * 10000 + amountInWithFee);

        lastMinAmountOut = minAmountOut;
        require(amountOut >= minAmountOut, "Slippage exceeded");
        require(amountOut > 0, "Zero output");

        address tokenOut = isA ? tokenB : tokenA;
        require(IMockRouterToken(tokenIn).transferFrom(msg.sender, address(this), amountIn), "Transfer in failed");
        require(IMockRouterToken(tokenOut).transfer(msg.sender, amountOut), "Transfer out failed");

        if (isA) {
            reserveA += amountIn;
            reserveB -= amountOut;
        } else {
            reserveB += amountIn;
            reserveA -= amountOut;
        }
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reserveA, reserveB);
    }
}
