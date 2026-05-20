// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockERC721 {
    mapping(uint256 => address) private owners;
    mapping(uint256 => address) private approvals;

    function mint(address to, uint256 tokenId) external {
        owners[tokenId] = to;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }

    function approve(address to, uint256 tokenId) external {
        require(owners[tokenId] == msg.sender, "Not owner");
        approvals[tokenId] = to;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return approvals[tokenId];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(owners[tokenId] == from, "Wrong owner");
        require(msg.sender == from || approvals[tokenId] == msg.sender, "Not approved");
        owners[tokenId] = to;
        approvals[tokenId] = address(0);
    }
}
