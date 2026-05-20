// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @contributor openai-codex-wallet-40
/// @platform Private platform/session initialization text intentionally omitted.
/// @runtime OS windows; arch x64; cwd D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell powershell.
/// @date 2026-05-20T09:20:22Z

/// @title GovernorAlpha
/// @notice Minimal governance contract supporting proposal creation, voting, and execution.
/// @dev Inspired by Compound's GovernorAlpha. Token holders propose and vote on-chain actions.
contract GovernorAlpha is ReentrancyGuard {
    enum ProposalState { Pending, Active, Defeated, Succeeded, Executed, Canceled }

    struct Proposal {
        uint256 id;
        address proposer;
        address[] targets;
        uint256[] values;
        bytes[] calldatas;
        uint256 startBlock;
        uint256 endBlock;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
        bool canceled;
        mapping(address => bool) hasVoted;
    }

    struct Delegation {
        address delegatee;
        uint256 expiresAt;
    }

    struct DelegationRecord {
        address delegatee;
        uint256 expiresAt;
        uint256 changedAt;
        bool revoked;
    }

    ERC20Votes public immutable token;
    uint256 public proposalCount;
    uint256 public constant VOTING_DELAY = 1; // blocks
    uint256 public constant VOTING_PERIOD = 17280; // ~3 days at 15s blocks
    uint256 public constant PROPOSAL_THRESHOLD = 100_000e18;
    uint256 public constant QUORUM_VOTES = 400_000e18;

    mapping(uint256 => Proposal) public proposals;
    mapping(address => Delegation) public delegations;
    mapping(address => DelegationRecord[]) private _delegationHistory;

    event ProposalCreated(uint256 indexed id, address proposer, uint256 startBlock, uint256 endBlock);
    event VoteCast(address indexed voter, uint256 indexed proposalId, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCanceled(uint256 indexed id, address indexed canceledBy, uint256 votesAtCancel);
    event VoteDelegated(address indexed delegator, address indexed delegatee, uint256 expiresAt);
    event DelegationCleared(address indexed delegator, address indexed delegatee);
    event DelegationExpired(address indexed delegator, address indexed delegatee, uint256 expiresAt);

    constructor(address _token) {
        token = ERC20Votes(_token);
    }

    /// @notice Create a new governance proposal.
    /// @param targets Contract addresses to call.
    /// @param values ETH values to send.
    /// @param calldatas Encoded function calls.
    /// @return proposalId The ID of the newly created proposal.
    function propose(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas
    ) external returns (uint256 proposalId) {
        require(targets.length == values.length && values.length == calldatas.length, "Governor: arity mismatch");
        require(token.getVotes(msg.sender) >= PROPOSAL_THRESHOLD, "Governor: below threshold");

        proposalId = ++proposalCount;
        Proposal storage p = proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        for (uint256 i = 0; i < targets.length; i++) {
            p.targets.push(targets[i]);
            p.values.push(values[i]);
            p.calldatas.push(calldatas[i]);
        }
        p.startBlock = block.number + VOTING_DELAY;
        p.endBlock = block.number + VOTING_DELAY + VOTING_PERIOD;

        emit ProposalCreated(proposalId, msg.sender, p.startBlock, p.endBlock);
    }

    /// @notice Delegate this account's GovernorAlpha voting action until an expiry timestamp.
    /// @param delegatee Account allowed to cast votes for msg.sender.
    /// @param expiresAt Timestamp when the delegation automatically expires.
    function delegate(address delegatee, uint256 expiresAt) external {
        require(delegatee != address(0), "Governor: zero delegatee");
        require(expiresAt > block.timestamp, "Governor: expired delegation");

        delegations[msg.sender] = Delegation({
            delegatee: delegatee,
            expiresAt: expiresAt
        });
        _delegationHistory[msg.sender].push(DelegationRecord({
            delegatee: delegatee,
            expiresAt: expiresAt,
            changedAt: block.timestamp,
            revoked: false
        }));

        emit VoteDelegated(msg.sender, delegatee, expiresAt);
    }

    /// @notice Clear the caller's active delegation.
    function clearDelegation() external {
        Delegation memory current = delegations[msg.sender];
        require(current.delegatee != address(0), "Governor: no delegation");

        delete delegations[msg.sender];
        _delegationHistory[msg.sender].push(DelegationRecord({
            delegatee: current.delegatee,
            expiresAt: current.expiresAt,
            changedAt: block.timestamp,
            revoked: true
        }));

        emit DelegationCleared(msg.sender, current.delegatee);
    }

    /// @notice Revoke an expired delegation and record the expiry in history.
    function revokeExpiredDelegation(address delegator) external returns (bool) {
        return _autoRevokeExpiredDelegation(delegator);
    }

    /// @notice Return active delegation info, or address(0) when expired.
    function delegationOf(address delegator) external view returns (address delegatee, uint256 expiresAt, bool active) {
        Delegation memory current = delegations[delegator];
        active = current.delegatee != address(0) && current.expiresAt >= block.timestamp;
        delegatee = active ? current.delegatee : address(0);
        expiresAt = current.expiresAt;
    }

    /// @notice Full delegation history for an account.
    function delegationHistory(address delegator) external view returns (DelegationRecord[] memory) {
        return _delegationHistory[delegator];
    }

    /// @notice Cast a vote on a proposal.
    /// @param proposalId The proposal to vote on.
    /// @param support True for yes, false for no.
    function vote(uint256 proposalId, bool support) external {
        _autoRevokeExpiredDelegation(msg.sender);
        _castVote(proposalId, msg.sender, support);
    }

    /// @notice Cast a vote for a delegator that has delegated to msg.sender.
    function voteFor(uint256 proposalId, address delegator, bool support) external {
        _autoRevokeExpiredDelegation(delegator);
        Delegation memory current = delegations[delegator];
        require(current.delegatee == msg.sender && current.expiresAt >= block.timestamp, "Governor: inactive delegation");
        _castVote(proposalId, delegator, support);
    }

    /// @notice Execute a succeeded proposal.
    /// @param proposalId The proposal to execute.
    function execute(uint256 proposalId) external payable nonReentrant {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "Governor: unknown proposal");
        require(!p.canceled, "Governor: canceled");
        require(!p.executed, "Governor: already executed");
        require(block.number > p.endBlock, "Governor: voting not ended");
        require(p.forVotes > p.againstVotes, "Governor: proposal defeated");

        p.executed = true;
        for (uint256 i = 0; i < p.targets.length; i++) {
            (bool ok, ) = p.targets[i].call{value: p.values[i]}(p.calldatas[i]);
            require(ok, "Governor: tx failed");
        }

        emit ProposalExecuted(proposalId);
    }

    /// @notice Cancel a proposal while its recorded vote total is still below quorum.
    /// @param proposalId The proposal to cancel.
    function cancelProposal(uint256 proposalId) public {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "Governor: unknown proposal");
        require(!p.executed, "Governor: already executed");
        require(!p.canceled, "Governor: already canceled");

        uint256 votesAtCancel = _proposalVoteTotal(p);
        require(votesAtCancel < QUORUM_VOTES, "Governor: quorum reached");
        require(
            msg.sender == p.proposer || token.getVotes(msg.sender) >= PROPOSAL_THRESHOLD,
            "Governor: cancel unauthorized"
        );

        p.canceled = true;
        emit ProposalCanceled(proposalId, msg.sender, votesAtCancel);
    }

    /// @notice Backwards-compatible cancel entrypoint.
    function cancel(uint256 proposalId) external {
        cancelProposal(proposalId);
    }

    /// @notice Return the current state for a proposal.
    function state(uint256 proposalId) external view returns (ProposalState) {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "Governor: unknown proposal");
        if (p.canceled) return ProposalState.Canceled;
        if (p.executed) return ProposalState.Executed;
        if (block.number < p.startBlock) return ProposalState.Pending;
        if (block.number <= p.endBlock) return ProposalState.Active;
        if (p.forVotes <= p.againstVotes) return ProposalState.Defeated;
        return ProposalState.Succeeded;
    }

    function _castVote(uint256 proposalId, address voter, bool support) internal {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "Governor: unknown proposal");
        require(!p.canceled, "Governor: canceled");
        require(block.number >= p.startBlock && block.number <= p.endBlock, "Governor: voting closed");
        require(!p.hasVoted[voter], "Governor: already voted");
        p.hasVoted[voter] = true;

        uint256 weight = token.getPastVotes(voter, p.startBlock);
        if (support) {
            p.forVotes += weight;
        } else {
            p.againstVotes += weight;
        }

        emit VoteCast(voter, proposalId, support, weight);
    }

    function _autoRevokeExpiredDelegation(address delegator) internal returns (bool) {
        Delegation memory current = delegations[delegator];
        if (current.delegatee == address(0) || current.expiresAt >= block.timestamp) {
            return false;
        }

        delete delegations[delegator];
        _delegationHistory[delegator].push(DelegationRecord({
            delegatee: current.delegatee,
            expiresAt: current.expiresAt,
            changedAt: block.timestamp,
            revoked: true
        }));

        emit DelegationExpired(delegator, current.delegatee, current.expiresAt);
        return true;
    }

    function _proposalVoteTotal(Proposal storage p) internal view returns (uint256) {
        return p.forVotes + p.againstVotes;
    }

    receive() external payable {}
}
