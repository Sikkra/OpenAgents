// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @contributor-info
/// @identity openai-codex-wallet-6
/// @session Private platform/session initialization text intentionally omitted.
/// @runtime OS windows; arch x64; home C:\Users\Ben; cwd D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell powershell.
/// @date 2026-05-20T09:20:22Z

/// @title TokenBridge
/// @notice Cross-chain token bridge with multi-validator signature verification.
/// @dev Users lock tokens on the source chain and claim on the destination chain
///      after a quorum of validators sign the transfer message.
contract TokenBridge is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Transfer {
        address token;
        address sender;
        address recipient;
        uint256 amount;
        uint256 nonce;
        bool claimed;
    }

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("BridgeClaim(address token,address sender,address recipient,uint256 amount,uint256 nonce)");
    bytes32 private constant NAME_HASH = keccak256("TokenBridge");
    bytes32 private constant VERSION_HASH = keccak256("1");

    address public admin;
    uint256 public requiredSignatures;
    mapping(address => bool) public isValidator;
    mapping(bytes32 => Transfer) public transfers;
    mapping(bytes32 => bool) public processedHashes;
    mapping(address => uint256) public nonces;

    event TokensLocked(
        bytes32 indexed transferId,
        address token,
        address sender,
        address recipient,
        uint256 amount,
        uint256 nonce
    );
    event TokensClaimed(
        bytes32 indexed transferId,
        address token,
        address sender,
        address recipient,
        uint256 amount,
        uint256 nonce
    );
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Bridge: not admin");
        _;
    }

    constructor(uint256 _requiredSignatures) {
        admin = msg.sender;
        requiredSignatures = _requiredSignatures;
    }

    /// @notice Lock tokens on the source chain to initiate a cross-chain transfer.
    /// @param token ERC20 token address.
    /// @param recipient Destination address on the target chain.
    /// @param amount Amount of tokens to bridge.
    function lock(address token, address recipient, uint256 amount) external nonReentrant {
        require(amount > 0, "Bridge: zero amount");

        uint256 nonce = nonces[msg.sender]++;
        bytes32 transferId = keccak256(
            abi.encode(block.chainid, address(this), token, msg.sender, recipient, amount, nonce)
        );

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        transfers[transferId] = Transfer({
            token: token,
            sender: msg.sender,
            recipient: recipient,
            amount: amount,
            nonce: nonce,
            claimed: false
        });

        emit TokensLocked(transferId, token, msg.sender, recipient, amount, nonce);
    }

    /// @notice Claim bridged tokens on the destination chain with validator signatures.
    /// @param token Token address.
    /// @param sender Source-chain sender address.
    /// @param recipient Recipient address.
    /// @param amount Amount to claim.
    /// @param nonce Source sender nonce for this transfer.
    /// @param signatures Array of validator ECDSA signatures (each 65 bytes).
    function claim(
        address token,
        address sender,
        address recipient,
        uint256 amount,
        uint256 nonce,
        bytes[] calldata signatures
    ) external nonReentrant {
        bytes32 transferId = claimTypedDataHash(token, sender, recipient, amount, nonce);

        require(!processedHashes[transferId], "Bridge: already processed");
        require(signatures.length >= requiredSignatures, "Bridge: insufficient sigs");

        uint256 validSigs = 0;
        address lastSigner = address(0);
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _recover(transferId, signatures[i]);
            require(signer > lastSigner, "Bridge: duplicate or unordered sig");
            lastSigner = signer;
            if (isValidator[signer]) {
                validSigs++;
            }
        }

        require(validSigs >= requiredSignatures, "Bridge: not enough valid sigs");
        processedHashes[transferId] = true;

        IERC20(token).safeTransfer(recipient, amount);
        emit TokensClaimed(transferId, token, sender, recipient, amount, nonce);
    }

    /// @notice EIP-712 domain separator bound to this chain and bridge deployment.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    /// @notice EIP-712 struct hash for a bridge claim.
    function claimStructHash(
        address token,
        address sender,
        address recipient,
        uint256 amount,
        uint256 nonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(CLAIM_TYPEHASH, token, sender, recipient, amount, nonce));
    }

    /// @notice Full EIP-712 digest that validators sign for a destination-chain claim.
    function claimTypedDataHash(
        address token,
        address sender,
        address recipient,
        uint256 amount,
        uint256 nonce
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), claimStructHash(token, sender, recipient, amount, nonce))
        );
    }

    function addValidator(address validator) external onlyAdmin {
        isValidator[validator] = true;
        emit ValidatorAdded(validator);
    }

    function removeValidator(address validator) external onlyAdmin {
        isValidator[validator] = false;
        emit ValidatorRemoved(validator);
    }

    /// @dev Recover signer from an ECDSA signature.
    function _recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "Bridge: invalid sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "Bridge: invalid signature");
        return signer;
    }
}
