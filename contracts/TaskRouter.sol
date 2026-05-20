// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AgentRegistry.sol";

contract TaskRouter {
    AgentRegistry public registry;
    address public owner;
    uint256 public constant LARGE_PAYOUT_THRESHOLD = 1 ether;
    uint256 public constant REQUIRED_APPROVALS = 2;
    uint256 public constant MAX_SIGNERS = 3;

    enum TaskStatus { Open, Assigned, Completed, Disputed, Cancelled }

    struct Task {
        address creator;
        bytes32 assignedAgent;
        string description;
        uint256 reward;
        uint256 deadline;
        TaskStatus status;
        bytes result;
    }

    struct PaymentApproval {
        address recipient;
        uint256 amount;
        uint256 approvalCount;
        bool executed;
    }

    mapping(uint256 => Task) public tasks;
    mapping(uint256 => PaymentApproval) public paymentApprovals;
    mapping(uint256 => mapping(address => bool)) public paymentApprovedBy;
    mapping(address => bool) public paymentSigners;
    uint256 public taskCount;
    uint256 public platformFee; // basis points
    uint256 public signerCount;

    event TaskCreated(uint256 indexed taskId, address indexed creator, uint256 reward);
    event TaskAssigned(uint256 indexed taskId, bytes32 indexed agentId);
    event TaskCompleted(uint256 indexed taskId, bytes32 indexed agentId);
    event TaskDisputed(uint256 indexed taskId);
    event PaymentSignerUpdated(address indexed signer, bool active);
    event LargePaymentPending(uint256 indexed taskId, address indexed recipient, uint256 amount);
    event PaymentApproved(uint256 indexed taskId, address indexed signer, uint256 approvals);
    event PaymentExecuted(uint256 indexed taskId, address indexed recipient, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "TaskRouter: not owner");
        _;
    }

    modifier onlyPaymentSigner() {
        require(paymentSigners[msg.sender], "TaskRouter: not signer");
        _;
    }

    constructor(address _registry, uint256 _platformFee) {
        registry = AgentRegistry(_registry);
        platformFee = _platformFee;
        owner = msg.sender;
    }

    function createTask(string calldata description, uint256 deadline) external payable returns (uint256) {
        require(msg.value > 0, "Reward required");
        require(deadline > block.timestamp, "Invalid deadline");

        uint256 taskId = taskCount++;
        tasks[taskId] = Task({
            creator: msg.sender,
            assignedAgent: bytes32(0),
            description: description,
            reward: msg.value,
            deadline: deadline,
            status: TaskStatus.Open,
            result: ""
        });

        emit TaskCreated(taskId, msg.sender, msg.value);
        return taskId;
    }

    function assignTask(uint256 taskId, bytes32 agentId) external {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Open, "Not open");
        require(block.timestamp < task.deadline, "Deadline passed");

        AgentRegistry.Agent memory agent = registry.getAgent(agentId);
        require(agent.active, "Agent not active");
        require(agent.owner == msg.sender, "Not agent owner");

        task.assignedAgent = agentId;
        task.status = TaskStatus.Assigned;

        emit TaskAssigned(taskId, agentId);
    }

    function completeTask(uint256 taskId, bytes calldata result) external {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Assigned, "Not assigned");

        AgentRegistry.Agent memory agent = registry.getAgent(task.assignedAgent);
        require(agent.owner == msg.sender, "Not assigned agent owner");

        task.result = result;
        task.status = TaskStatus.Completed;

        uint256 fee = task.reward * platformFee / 10000;
        uint256 payout = task.reward - fee;

        if (payout < LARGE_PAYOUT_THRESHOLD) {
            _executePayment(taskId, msg.sender, payout);
        } else {
            PaymentApproval storage approval = paymentApprovals[taskId];
            approval.recipient = msg.sender;
            approval.amount = payout;
            emit LargePaymentPending(taskId, msg.sender, payout);
        }

        emit TaskCompleted(taskId, task.assignedAgent);
    }

    function approvePayment(uint256 taskId) external onlyPaymentSigner {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Completed, "TaskRouter: task not completed");

        PaymentApproval storage approval = paymentApprovals[taskId];
        require(approval.recipient != address(0), "TaskRouter: no pending payment");
        require(!approval.executed, "TaskRouter: payment executed");
        require(!paymentApprovedBy[taskId][msg.sender], "TaskRouter: already approved");

        paymentApprovedBy[taskId][msg.sender] = true;
        approval.approvalCount += 1;
        emit PaymentApproved(taskId, msg.sender, approval.approvalCount);

        if (approval.approvalCount >= REQUIRED_APPROVALS) {
            _executePayment(taskId, approval.recipient, approval.amount);
            approval.executed = true;
        }
    }

    function setPaymentSigner(address signer, bool active) external onlyOwner {
        require(signer != address(0), "TaskRouter: zero signer");
        if (active) {
            require(!paymentSigners[signer], "TaskRouter: signer exists");
            require(signerCount < MAX_SIGNERS, "TaskRouter: signer limit");
            paymentSigners[signer] = true;
            signerCount += 1;
        } else {
            require(paymentSigners[signer], "TaskRouter: signer missing");
            paymentSigners[signer] = false;
            signerCount -= 1;
        }

        emit PaymentSignerUpdated(signer, active);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "TaskRouter: zero owner");
        owner = newOwner;
    }

    function _executePayment(uint256 taskId, address recipient, uint256 amount) internal {
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "Payout failed");
        emit PaymentExecuted(taskId, recipient, amount);
    }

    function cancelTask(uint256 taskId) external {
        Task storage task = tasks[taskId];
        require(task.creator == msg.sender, "Not creator");
        require(task.status == TaskStatus.Open, "Cannot cancel");

        task.status = TaskStatus.Cancelled;
        (bool success, ) = msg.sender.call{value: task.reward}("");
        require(success, "Refund failed");
    }

    function disputeTask(uint256 taskId) external {
        Task storage task = tasks[taskId];
        require(task.creator == msg.sender, "Not creator");
        require(task.status == TaskStatus.Assigned, "Not assigned");
        require(block.timestamp > task.deadline, "Deadline not passed");

        task.status = TaskStatus.Disputed;
        emit TaskDisputed(taskId);
    }
}
