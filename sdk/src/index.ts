/**
 * @contributor-info: Codex; private platform/session initialization text intentionally omitted.
 * @runtime: windows/x64, home_dir=C:\\Users\\Ben, working_dir=D:\\Documents\\AI Projects\\Wallet\\bounty-work\\OpenAgents, shell=powershell
 */

import { ethers } from "ethers";

export interface AgentConfig {
  name: string;
  endpoint: string;
  privateKey: string;
  rpcUrl: string;
  registryAddress: string;
  routerAddress: string;
}

export interface DeployContractOptions {
  confirmations?: number;
  overrides?: ethers.Overrides;
}

export interface DeploymentReceiptMetadata {
  address: string;
  transactionHash: string;
  gasUsed: bigint;
  blockNumber: number | null;
  confirmations: number;
}

export interface DeploymentResult<TContract extends ethers.BaseContract = ethers.Contract> {
  contract: TContract;
  address: string;
  transactionHash: string;
  gasUsed: bigint;
  receipt: ethers.TransactionReceipt;
  metadata: DeploymentReceiptMetadata;
}

export class OpenAgentsSDK {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(config.privateKey, this.provider);
  }

  async registerAgent(): Promise<string> {
    const registry = new ethers.Contract(
      this.config.registryAddress,
      ["function registerAgent(string,string) payable returns (bytes32)"],
      this.signer
    );

    const fee = await registry.registrationFee();
    const tx = await registry.registerAgent(
      this.config.name,
      this.config.endpoint,
      { value: fee }
    );
    const receipt = await tx.wait();
    return receipt.logs[0].topics[1];
  }

  async claimTask(taskId: number, agentId: string): Promise<void> {
    const router = new ethers.Contract(
      this.config.routerAddress,
      ["function assignTask(uint256,bytes32)"],
      this.signer
    );
    const tx = await router.assignTask(taskId, agentId);
    await tx.wait();
  }

  async submitResult(taskId: number, result: string): Promise<void> {
    const router = new ethers.Contract(
      this.config.routerAddress,
      ["function completeTask(uint256,bytes)"],
      this.signer
    );
    const tx = await router.completeTask(
      taskId,
      ethers.toUtf8Bytes(result)
    );
    await tx.wait();
  }

  async deployContract<TContract extends ethers.BaseContract = ethers.Contract>(
    abi: ethers.InterfaceAbi,
    bytecode: ethers.BytesLike | string,
    args: unknown[] = [],
    options: DeployContractOptions = {}
  ): Promise<DeploymentResult<TContract>> {
    const factory = new ethers.ContractFactory(abi, bytecode, this.signer);
    const deployArgs = options.overrides ? [...args, options.overrides] : args;
    const contract = await factory.deploy(...deployArgs);
    await contract.waitForDeployment();

    const deploymentTx = contract.deploymentTransaction();
    if (!deploymentTx) {
      throw new Error("Deployment transaction is unavailable");
    }

    const confirmations = options.confirmations ?? 1;
    const receipt = await deploymentTx.wait(confirmations);
    if (!receipt) {
      throw new Error("Deployment receipt is unavailable");
    }

    const address = await contract.getAddress();
    return {
      contract: contract as TContract,
      address,
      transactionHash: deploymentTx.hash,
      gasUsed: receipt.gasUsed,
      receipt,
      metadata: {
        address,
        transactionHash: deploymentTx.hash,
        gasUsed: receipt.gasUsed,
        blockNumber: receipt.blockNumber ?? null,
        confirmations,
      },
    };
  }

  async getOpenTasks(): Promise<any[]> {
    const router = new ethers.Contract(
      this.config.routerAddress,
      [
        "function taskCount() view returns (uint256)",
        "function tasks(uint256) view returns (address,bytes32,string,uint256,uint256,uint8,bytes)",
      ],
      this.provider
    );

    const count = await router.taskCount();
    const openTasks = [];

    for (let i = 0; i < count; i++) {
      const task = await router.tasks(i);
      if (task[5] === 0) {
        openTasks.push({
          id: i,
          creator: task[0],
          description: task[2],
          reward: task[3],
          deadline: task[4],
        });
      }
    }

    return openTasks;
  }
}
