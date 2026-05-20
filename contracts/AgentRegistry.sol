// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract AgentRegistry is Ownable {
    struct Agent {
        address owner;
        string name;
        string endpoint;
        uint256 reputation;
        uint256 tasksCompleted;
        uint256 registeredAt;
        bool active;
    }

    mapping(bytes32 => Agent) public agents;
    mapping(address => bytes32[]) public ownerAgents;
    bytes32[] public agentIds;
    bytes32[] private activeAgentIds;
    mapping(bytes32 => uint256) private activeAgentIndex;

    uint256 public registrationFee;
    uint256 public minReputation;
    uint256 public activeCount;

    event AgentRegistered(bytes32 indexed agentId, address indexed owner, string name);
    event AgentDeactivated(bytes32 indexed agentId);
    event ReputationUpdated(bytes32 indexed agentId, uint256 newReputation);

    constructor(uint256 _registrationFee) Ownable(msg.sender) {
        registrationFee = _registrationFee;
        minReputation = 0;
    }

    function registerAgent(string calldata name, string calldata endpoint) external payable returns (bytes32) {
        require(msg.value >= registrationFee, "Insufficient fee");
        require(bytes(name).length > 0 && bytes(name).length <= 64, "Invalid name");

        bytes32 agentId = keccak256(abi.encodePacked(msg.sender, name, block.timestamp));

        require(agents[agentId].registeredAt == 0, "Agent exists");

        agents[agentId] = Agent({
            owner: msg.sender,
            name: name,
            endpoint: endpoint,
            reputation: 100,
            tasksCompleted: 0,
            registeredAt: block.timestamp,
            active: true
        });

        ownerAgents[msg.sender].push(agentId);
        agentIds.push(agentId);
        activeAgentIds.push(agentId);
        activeAgentIndex[agentId] = activeAgentIds.length;
        activeCount++;

        emit AgentRegistered(agentId, msg.sender, name);
        return agentId;
    }

    function deactivateAgent(bytes32 agentId) external {
        Agent storage agent = agents[agentId];
        require(agent.owner == msg.sender, "Not agent owner");
        require(agent.active, "Agent inactive");

        agent.active = false;
        activeCount--;
        _removeActiveAgent(agentId);
        emit AgentDeactivated(agentId);
    }

    function updateReputation(bytes32 agentId, int256 delta) external onlyOwner {
        Agent storage agent = agents[agentId];
        require(agent.registeredAt > 0, "Agent not found");

        if (delta > 0) {
            agent.reputation += uint256(delta);
        } else {
            uint256 decrease = uint256(-delta);
            agent.reputation = agent.reputation > decrease ? agent.reputation - decrease : 0;
        }

        emit ReputationUpdated(agentId, agent.reputation);
    }

    function getAgent(bytes32 agentId) external view returns (Agent memory) {
        return agents[agentId];
    }

    function getActiveAgentCount() external view returns (uint256) {
        return activeCount;
    }

    function getAgentIds(uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        return _paginate(agentIds, offset, limit);
    }

    function getActiveAgentIds(uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        return _paginate(activeAgentIds, offset, limit);
    }

    function getAgentsByOwner(address agentOwner) external view returns (bytes32[] memory) {
        return ownerAgents[agentOwner];
    }

    function getAgentsByOwner(
        address agentOwner,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory) {
        return _paginate(ownerAgents[agentOwner], offset, limit);
    }

    function setRegistrationFee(uint256 _fee) external onlyOwner {
        registrationFee = _fee;
    }

    function withdrawFees() external onlyOwner {
        (bool success, ) = owner().call{value: address(this).balance}("");
        require(success, "Withdraw failed");
    }

    function _removeActiveAgent(bytes32 agentId) private {
        uint256 indexPlusOne = activeAgentIndex[agentId];
        if (indexPlusOne == 0) return;

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = activeAgentIds.length - 1;
        if (index != lastIndex) {
            bytes32 lastAgentId = activeAgentIds[lastIndex];
            activeAgentIds[index] = lastAgentId;
            activeAgentIndex[lastAgentId] = index + 1;
        }

        activeAgentIds.pop();
        delete activeAgentIndex[agentId];
    }

    function _paginate(
        bytes32[] storage source,
        uint256 offset,
        uint256 limit
    ) private view returns (bytes32[] memory page) {
        if (offset >= source.length || limit == 0) {
            return new bytes32[](0);
        }

        uint256 remaining = source.length - offset;
        uint256 size = remaining < limit ? remaining : limit;
        page = new bytes32[](size);
        for (uint256 i = 0; i < size; i++) {
            page[i] = source[offset + i];
        }
    }
}
