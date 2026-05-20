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
  overrides?: Record<string, unknown>;
}

export interface DeploymentResult<TContract = ethers.Contract> {
  contract: TContract;
  address: string;
  transactionHash: string;
  gasUsed: bigint;
  receipt: ethers.TransactionReceipt;
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

  async deployContract<TContract = ethers.Contract>(
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

    const receipt = await deploymentTx.wait(options.confirmations ?? 1);
    if (!receipt) {
      throw new Error("Deployment receipt is unavailable");
    }

    return {
      contract: contract as TContract,
      address: await contract.getAddress(),
      transactionHash: deploymentTx.hash,
      gasUsed: receipt.gasUsed,
      receipt,
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
