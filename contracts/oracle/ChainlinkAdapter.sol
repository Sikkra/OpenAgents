// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface AggregatorV3Interface {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

/// @title ChainlinkAdapter
/// @notice Adapter for Chainlink price feeds with normalized 18-decimal output
/// @dev Wraps one or more Chainlink aggregators behind a simple getPrice interface
contract ChainlinkAdapter {
    address public admin;
    uint256 public constant TARGET_DECIMALS = 18;

    struct FeedConfig {
        AggregatorV3Interface feed;
        AggregatorV3Interface fallbackFeed;
        uint256 heartbeat; // max seconds between updates
        bool active;
    }

    mapping(address => FeedConfig) public feeds;

    event FeedRegistered(address indexed token, address feed, uint256 heartbeat);
    event FallbackFeedRegistered(address indexed token, address feed);
    event FeedDeactivated(address indexed token);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function registerFeed(
        address token,
        address feed,
        uint256 heartbeat
    ) external onlyAdmin {
        require(feed != address(0), "Invalid feed");
        require(heartbeat > 0, "Invalid heartbeat");

        feeds[token] = FeedConfig({
            feed: AggregatorV3Interface(feed),
            fallbackFeed: AggregatorV3Interface(address(0)),
            heartbeat: heartbeat,
            active: true
        });

        emit FeedRegistered(token, feed, heartbeat);
    }

    function setFallbackFeed(address token, address feed) external onlyAdmin {
        require(feeds[token].active, "Feed not active");
        require(feed != address(0), "Invalid feed");
        feeds[token].fallbackFeed = AggregatorV3Interface(feed);
        emit FallbackFeedRegistered(token, feed);
    }

    function deactivateFeed(address token) external onlyAdmin {
        feeds[token].active = false;
        emit FeedDeactivated(token);
    }

    function getPrice(address token) external view returns (uint256) {
        FeedConfig storage config = feeds[token];
        require(config.active, "Feed not active");
        return _readPrice(config.feed, config.fallbackFeed, config.heartbeat);
    }

    function getFeedInfo(address token) external view returns (
        address feedAddress,
        uint256 heartbeat,
        bool active
    ) {
        FeedConfig storage config = feeds[token];
        return (address(config.feed), config.heartbeat, config.active);
    }

    function getFallbackFeed(address token) external view returns (address) {
        return address(feeds[token].fallbackFeed);
    }

    function _readPrice(
        AggregatorV3Interface feed,
        AggregatorV3Interface fallbackFeed,
        uint256 heartbeat
    ) internal view returns (uint256) {
        (uint256 price, bool stale) = _validatedFeedPrice(feed, heartbeat);
        if (stale) {
            require(address(fallbackFeed) != address(0), "Price stale");
            (price, stale) = _validatedFeedPrice(fallbackFeed, heartbeat);
            require(!stale, "Fallback price stale");
        }
        return price;
    }

    function _validatedFeedPrice(
        AggregatorV3Interface feed,
        uint256 heartbeat
    ) internal view returns (uint256 price, bool stale) {
        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = feed.latestRoundData();
        startedAt;

        require(answeredInRound >= roundId, "Incomplete round");
        require(updatedAt > 0, "Incomplete round");
        require(answer > 0, "Invalid price");

        stale = block.timestamp > updatedAt + heartbeat;
        price = uint256(answer);

        uint8 feedDecimals = feed.decimals();
        if (feedDecimals < TARGET_DECIMALS) {
            price = price * (10 ** (TARGET_DECIMALS - feedDecimals));
        } else if (feedDecimals > TARGET_DECIMALS) {
            price = price / (10 ** (feedDecimals - TARGET_DECIMALS));
        }
    }
}
