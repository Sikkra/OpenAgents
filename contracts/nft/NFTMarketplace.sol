// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC2981 {
    function royaltyInfo(
        uint256 tokenId,
        uint256 salePrice
    ) external view returns (address receiver, uint256 royaltyAmount);
}

/// @title NFTMarketplace
/// @notice Decentralized marketplace for listing, buying, and canceling NFT sales
/// @dev Supports any ERC721-compliant NFT contract
contract NFTMarketplace {
    bytes4 private constant ERC2981_INTERFACE_ID = 0x2a55205a;
    uint256 public constant DEFAULT_LISTING_DURATION = 7 days;
    uint256 public constant CANCEL_DELAY = 5 minutes;

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;
        uint256 expiresAt;
        uint256 cancelAvailableAt;
        bool active;
    }

    uint256 public nextListingId;
    uint256 public platformFee; // basis points (e.g., 250 = 2.5%)
    address public feeRecipient;

    mapping(uint256 => Listing) public listings;

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address nftContract,
        uint256 tokenId,
        uint256 price,
        uint256 expiresAt
    );
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 price);
    event CancelRequested(uint256 indexed listingId, uint256 cancelAvailableAt);
    event Canceled(uint256 indexed listingId);
    event RoyaltyPaid(uint256 indexed listingId, address indexed receiver, uint256 amount);

    constructor(uint256 _platformFee, address _feeRecipient) {
        require(_platformFee <= 10000, "Fee too high");
        require(_feeRecipient != address(0), "Zero fee recipient");
        platformFee = _platformFee;
        feeRecipient = _feeRecipient;
    }

    function listNFT(address nftContract, uint256 tokenId, uint256 price) external returns (uint256) {
        return listNFTWithExpiry(nftContract, tokenId, price, block.timestamp + DEFAULT_LISTING_DURATION);
    }

    function listNFTWithExpiry(
        address nftContract,
        uint256 tokenId,
        uint256 price,
        uint256 expiresAt
    ) public returns (uint256) {
        require(price > 0, "Zero price");
        require(expiresAt > block.timestamp, "Invalid expiry");

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
            expiresAt: expiresAt,
            cancelAvailableAt: 0,
            active: true
        });

        emit Listed(listingId, msg.sender, nftContract, tokenId, price, expiresAt);
        return listingId;
    }

    function buyNFT(uint256 listingId) external payable {
        Listing storage listing = listings[listingId];
        require(listing.active, "Not active");
        require(block.timestamp <= listing.expiresAt, "Listing expired");
        require(msg.value == listing.price, "Wrong price");

        listing.active = false;

        uint256 fee = (msg.value * platformFee) / 10000;
        uint256 sellerProceeds = msg.value - fee;
        (address royaltyReceiver, uint256 royaltyAmount) = _royaltyInfo(
            listing.nftContract,
            listing.tokenId,
            msg.value
        );
        if (royaltyReceiver != address(0) && royaltyAmount > 0) {
            require(royaltyAmount <= sellerProceeds, "Royalty exceeds proceeds");
            sellerProceeds -= royaltyAmount;
        } else {
            royaltyAmount = 0;
        }

        IERC721(listing.nftContract).transferFrom(
            listing.seller,
            msg.sender,
            listing.tokenId
        );

        _sendValue(feeRecipient, fee, "Fee transfer failed");
        if (royaltyAmount > 0) {
            _sendValue(royaltyReceiver, royaltyAmount, "Royalty transfer failed");
            emit RoyaltyPaid(listingId, royaltyReceiver, royaltyAmount);
        }
        _sendValue(listing.seller, sellerProceeds, "Seller transfer failed");

        emit Sold(listingId, msg.sender, msg.value);
    }

    function requestCancel(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        require(listing.active, "Not active");
        require(listing.seller == msg.sender, "Not seller");

        listing.cancelAvailableAt = block.timestamp + CANCEL_DELAY;
        emit CancelRequested(listingId, listing.cancelAvailableAt);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        require(listing.active, "Not active");
        require(listing.seller == msg.sender, "Not seller");
        require(listing.cancelAvailableAt != 0, "Cancel not requested");
        require(block.timestamp >= listing.cancelAvailableAt, "Cancel delay active");

        listing.active = false;
        emit Canceled(listingId);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function _royaltyInfo(
        address nftContract,
        uint256 tokenId,
        uint256 salePrice
    ) internal view returns (address receiver, uint256 amount) {
        try IERC165(nftContract).supportsInterface(ERC2981_INTERFACE_ID) returns (bool supported) {
            if (!supported) {
                return (address(0), 0);
            }
        } catch {
            return (address(0), 0);
        }

        try IERC2981(nftContract).royaltyInfo(tokenId, salePrice) returns (
            address royaltyReceiver,
            uint256 royaltyAmount
        ) {
            return (royaltyReceiver, royaltyAmount);
        } catch {
            return (address(0), 0);
        }
    }

    function _sendValue(address recipient, uint256 amount, string memory errorMessage) internal {
        if (amount == 0) {
            return;
        }
        (bool success, ) = recipient.call{value: amount}("");
        require(success, errorMessage);
    }
}
