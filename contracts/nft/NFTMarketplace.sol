// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
}

/// @title NFTMarketplace
/// @notice Decentralized marketplace for listing, buying, and canceling NFT sales
/// @dev Supports any ERC721-compliant NFT contract
contract NFTMarketplace {
    uint256 public constant MIN_BID_INCREMENT_BPS = 500; // 5%

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;
        bool active;
    }

    struct Auction {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 startPrice;
        uint256 reservePrice;
        uint256 endTime;
        address highestBidder;
        uint256 highestBid;
        bool active;
        bool settled;
    }

    uint256 public nextListingId;
    uint256 public nextAuctionId;
    uint256 public platformFee; // basis points (e.g., 250 = 2.5%)
    address public feeRecipient;

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Auction) public auctions;

    event Listed(uint256 indexed listingId, address indexed seller, address nftContract, uint256 tokenId, uint256 price);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 price);
    event Canceled(uint256 indexed listingId);
    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address nftContract,
        uint256 tokenId,
        uint256 startPrice,
        uint256 reservePrice,
        uint256 endTime
    );
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 amount, bool reserveMet);

    constructor(uint256 _platformFee, address _feeRecipient) {
        platformFee = _platformFee;
        feeRecipient = _feeRecipient;
    }

    // BUG: Price can be zero — allows listings with price 0, meaning NFTs can
    // be "sold" for free and the platform earns no fee
    function listNFT(address nftContract, uint256 tokenId, uint256 price) external returns (uint256) {
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Not NFT owner");
        require(
            nft.getApproved(tokenId) == address(this),
            "Marketplace not approved"
        );

        uint256 listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            price: price,
            active: true
        });

        emit Listed(listingId, msg.sender, nftContract, tokenId, price);
        return listingId;
    }

    // BUG: Seller can front-run cancel after buyer's tx is in mempool —
    // seller sees buy tx, quickly cancels to re-list at higher price (no commit-reveal)
    // BUG: No royalty payment — original creator receives nothing on secondary sales,
    // violating ERC-2981 royalty standard expectations
    function buyNFT(uint256 listingId) external payable {
        Listing storage listing = listings[listingId];
        require(listing.active, "Not active");
        require(msg.value == listing.price, "Wrong price");

        listing.active = false;

        uint256 fee = (msg.value * platformFee) / 10000;
        uint256 sellerProceeds = msg.value - fee;

        IERC721(listing.nftContract).transferFrom(
            listing.seller,
            msg.sender,
            listing.tokenId
        );

        (bool feeSent, ) = feeRecipient.call{value: fee}("");
        require(feeSent, "Fee transfer failed");

        (bool sellerSent, ) = listing.seller.call{value: sellerProceeds}("");
        require(sellerSent, "Seller transfer failed");

        emit Sold(listingId, msg.sender, msg.value);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        require(listing.active, "Not active");
        require(listing.seller == msg.sender, "Not seller");

        listing.active = false;
        emit Canceled(listingId);
    }

    function createAuction(
        address nftContract,
        uint256 tokenId,
        uint256 startPrice,
        uint256 reservePrice,
        uint256 duration
    ) external returns (uint256) {
        require(startPrice > 0, "Invalid start price");
        require(reservePrice >= startPrice, "Invalid reserve");
        require(duration > 0, "Invalid duration");

        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Not NFT owner");
        require(nft.getApproved(tokenId) == address(this), "Marketplace not approved");

        nft.transferFrom(msg.sender, address(this), tokenId);

        uint256 auctionId = nextAuctionId++;
        uint256 endTime = block.timestamp + duration;
        auctions[auctionId] = Auction({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            startPrice: startPrice,
            reservePrice: reservePrice,
            endTime: endTime,
            highestBidder: address(0),
            highestBid: 0,
            active: true,
            settled: false
        });

        emit AuctionCreated(auctionId, msg.sender, nftContract, tokenId, startPrice, reservePrice, endTime);
        return auctionId;
    }

    function placeBid(uint256 auctionId) external payable {
        Auction storage auction = auctions[auctionId];
        require(auction.active, "Not active");
        require(block.timestamp < auction.endTime, "Auction ended");

        uint256 minBid = auction.highestBid == 0
            ? auction.startPrice
            : auction.highestBid + ((auction.highestBid * MIN_BID_INCREMENT_BPS) / 10000);
        require(msg.value >= minBid, "Bid too low");

        address previousBidder = auction.highestBidder;
        uint256 previousBid = auction.highestBid;

        auction.highestBidder = msg.sender;
        auction.highestBid = msg.value;

        if (previousBidder != address(0)) {
            (bool refunded, ) = previousBidder.call{value: previousBid}("");
            require(refunded, "Refund failed");
        }

        emit BidPlaced(auctionId, msg.sender, msg.value);
    }

    function settleAuction(uint256 auctionId) external {
        Auction storage auction = auctions[auctionId];
        require(auction.active, "Not active");
        require(block.timestamp >= auction.endTime, "Auction active");

        auction.active = false;
        auction.settled = true;

        bool reserveMet = auction.highestBidder != address(0) && auction.highestBid >= auction.reservePrice;
        if (!reserveMet) {
            IERC721(auction.nftContract).transferFrom(address(this), auction.seller, auction.tokenId);
            if (auction.highestBidder != address(0)) {
                (bool refunded, ) = auction.highestBidder.call{value: auction.highestBid}("");
                require(refunded, "Refund failed");
            }
            emit AuctionSettled(auctionId, address(0), auction.highestBid, false);
            return;
        }

        IERC721(auction.nftContract).transferFrom(address(this), auction.highestBidder, auction.tokenId);

        uint256 fee = (auction.highestBid * platformFee) / 10000;
        uint256 sellerProceeds = auction.highestBid - fee;

        (bool feeSent, ) = feeRecipient.call{value: fee}("");
        require(feeSent, "Fee transfer failed");
        (bool sellerSent, ) = auction.seller.call{value: sellerProceeds}("");
        require(sellerSent, "Seller transfer failed");

        emit AuctionSettled(auctionId, auction.highestBidder, auction.highestBid, true);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return auctions[auctionId];
    }
}
