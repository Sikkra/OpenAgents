// SPDX-License-Identifier: MIT
// @contributor openai-codex-wallet-142
// @platform Private platform/session initialization text intentionally omitted.
// @runtime os=windows; arch=x64; working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell=powershell
// @date 2026-05-20T08:28:50Z
pragma solidity ^0.8.20;

import "../utils/Permit2Transfer.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title AMMPool
/// @notice Constant product (x*y=k) automated market maker pool
/// @dev Supports adding/removing liquidity and token swaps with a fee
contract AMMPool {
    IERC20 public tokenA;
    IERC20 public tokenB;

    uint256 public reserveA;
    uint256 public reserveB;
    uint256 public totalLiquidity;
    uint256 public constant FEE_BPS = 30; // 0.3%

    mapping(address => uint256) public liquidity;

    event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB, uint256 lpTokens);
    event LiquidityRemoved(address indexed provider, uint256 amountA, uint256 amountB);
    event Swap(address indexed user, address tokenIn, uint256 amountIn, uint256 amountOut);

    constructor(address _tokenA, address _tokenB) {
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
    }

    // BUG: No minimum liquidity lock — first LP can add tiny liquidity then remove it all,
    // enabling a well-known inflation attack where attacker donates tokens to manipulate
    // share price and steal from the next depositor
    function addLiquidity(uint256 amountA, uint256 amountB) external returns (uint256 lpTokens) {
        require(amountA > 0 && amountB > 0, "Zero amounts");

        lpTokens = _quoteLiquidity(amountA, amountB);

        require(tokenA.transferFrom(msg.sender, address(this), amountA), "Transfer A failed");
        require(tokenB.transferFrom(msg.sender, address(this), amountB), "Transfer B failed");

        reserveA += amountA;
        reserveB += amountB;
        liquidity[msg.sender] += lpTokens;
        totalLiquidity += lpTokens;

        emit LiquidityAdded(msg.sender, amountA, amountB, lpTokens);
    }

    /// @notice Add liquidity using Permit2 signatures instead of prior ERC20 approvals.
    function addLiquidityWithPermit2(
        uint256 amountA,
        uint256 amountB,
        uint256 nonceA,
        uint256 deadlineA,
        bytes calldata signatureA,
        uint256 nonceB,
        uint256 deadlineB,
        bytes calldata signatureB
    ) external returns (uint256 lpTokens) {
        require(amountA > 0 && amountB > 0, "Zero amounts");

        lpTokens = _quoteLiquidity(amountA, amountB);

        Permit2Transfer.permitTransferFrom(address(tokenA), msg.sender, address(this), amountA, nonceA, deadlineA, signatureA);
        Permit2Transfer.permitTransferFrom(address(tokenB), msg.sender, address(this), amountB, nonceB, deadlineB, signatureB);

        reserveA += amountA;
        reserveB += amountB;
        liquidity[msg.sender] += lpTokens;
        totalLiquidity += lpTokens;

        emit LiquidityAdded(msg.sender, amountA, amountB, lpTokens);
    }

    function removeLiquidity(uint256 lpTokens) external {
        require(lpTokens > 0 && lpTokens <= liquidity[msg.sender], "Invalid amount");

        uint256 amountA = (lpTokens * reserveA) / totalLiquidity;
        uint256 amountB = (lpTokens * reserveB) / totalLiquidity;

        liquidity[msg.sender] -= lpTokens;
        totalLiquidity -= lpTokens;
        reserveA -= amountA;
        reserveB -= amountB;

        require(tokenA.transfer(msg.sender, amountA), "Transfer A failed");
        require(tokenB.transfer(msg.sender, amountB), "Transfer B failed");

        emit LiquidityRemoved(msg.sender, amountA, amountB);
    }

    // BUG: Swap has no deadline parameter — transaction can sit in mempool and execute
    // at a much later time when price has moved unfavorably (stale transaction attack)
    // BUG: Fee truncates to zero for small swaps — (amountIn * 30) / 10000 rounds to 0
    // when amountIn < 334, meaning tiny swaps pay no fee and can drain value over time
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut) {
        require(tokenIn == address(tokenA) || tokenIn == address(tokenB), "Invalid token");
        require(amountIn > 0, "Zero input");

        bool isA = tokenIn == address(tokenA);
        (uint256 resIn, uint256 resOut) = isA ? (reserveA, reserveB) : (reserveB, reserveA);

        uint256 amountInWithFee = amountIn * (10000 - FEE_BPS);
        amountOut = (amountInWithFee * resOut) / (resIn * 10000 + amountInWithFee);

        require(amountOut >= minAmountOut, "Slippage exceeded");

        IERC20 tIn = isA ? tokenA : tokenB;
        IERC20 tOut = isA ? tokenB : tokenA;

        require(tIn.transferFrom(msg.sender, address(this), amountIn), "Transfer in failed");
        require(tOut.transfer(msg.sender, amountOut), "Transfer out failed");

        if (isA) {
            reserveA += amountIn;
            reserveB -= amountOut;
        } else {
            reserveB += amountIn;
            reserveA -= amountOut;
        }

        emit Swap(msg.sender, tokenIn, amountIn, amountOut);
    }

    /// @notice Swap using a Permit2 signature instead of a prior ERC20 approval.
    function swapWithPermit2(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 amountOut) {
        require(tokenIn == address(tokenA) || tokenIn == address(tokenB), "Invalid token");
        require(amountIn > 0, "Zero input");

        bool isA = tokenIn == address(tokenA);
        (uint256 resIn, uint256 resOut) = isA ? (reserveA, reserveB) : (reserveB, reserveA);

        uint256 amountInWithFee = amountIn * (10000 - FEE_BPS);
        amountOut = (amountInWithFee * resOut) / (resIn * 10000 + amountInWithFee);

        require(amountOut >= minAmountOut, "Slippage exceeded");

        IERC20 tOut = isA ? tokenB : tokenA;

        Permit2Transfer.permitTransferFrom(tokenIn, msg.sender, address(this), amountIn, nonce, deadline, signature);
        require(tOut.transfer(msg.sender, amountOut), "Transfer out failed");

        if (isA) {
            reserveA += amountIn;
            reserveB -= amountOut;
        } else {
            reserveB += amountIn;
            reserveA -= amountOut;
        }

        emit Swap(msg.sender, tokenIn, amountIn, amountOut);
    }

    function _quoteLiquidity(uint256 amountA, uint256 amountB) internal view returns (uint256 lpTokens) {
        if (totalLiquidity == 0) {
            return _sqrt(amountA * amountB);
        }
        uint256 lpA = (amountA * totalLiquidity) / reserveA;
        uint256 lpB = (amountB * totalLiquidity) / reserveB;
        return lpA < lpB ? lpA : lpB;
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reserveA, reserveB);
    }
}
