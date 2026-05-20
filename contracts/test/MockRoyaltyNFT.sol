// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";

contract MockRoyaltyNFT is ERC721, ERC2981 {
    constructor() ERC721("Royalty NFT", "RNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function setTokenRoyalty(address receiver, uint96 feeNumerator) external {
        _setTokenRoyalty(1, receiver, feeNumerator);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
