/**
 * @fix-author: Codex
 * @date: 2026-05-20
 * @platform-config: private platform/session instructions intentionally omitted
 * @runtime: windows/x64, powershell, OpenAgents workspace
 */
import { ethers } from "ethers";

export interface AgentConfig {
  name: string;
  endpoint: string;
  privateKey: string;
  rpcUrl: string;
  registryAddress: string;
  routerAddress: string;
  provider?: ethers.Provider;
  signer?: ethers.Signer;
  contractFactory?: (
    address: string,
    abi: string[],
    runner: ethers.ContractRunner | null
  ) => any;
}

export interface GetOpenTasksOptions {
  offset?: number;
  limit?: number;
  status?: number | null;
  batchSize?: number;
}

export interface OpenTask {
  id: number;
  creator: string;
  description: string;
  reward: bigint;
  deadline: bigint;
  status: number;
}

export class OpenAgentsSDK {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private config: AgentConfig;
  private taskCountCache: { blockNumber: number; count: number } | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.provider = config.provider ?? new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = config.signer ?? new ethers.Wallet(config.privateKey, this.provider);
  }

  async registerAgent(): Promise<string> {
    const registry = this.createContract(
      this.config.registryAddress,
      ["function registerAgent(string,string) payable returns (bytes32)", "function registrationFee() view returns (uint256)"],
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
    const router = this.createRouter(this.signer);
    const tx = await router.assignTask(taskId, agentId);
    await tx.wait();
  }

  async submitResult(taskId: number, result: string): Promise<void> {
    const router = this.createRouter(this.signer);
    const tx = await router.completeTask(
      taskId,
      ethers.toUtf8Bytes(result)
    );
    await tx.wait();
  }

  async getOpenTasks(options: GetOpenTasksOptions = {}): Promise<OpenTask[]> {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(0, options.limit ?? 50);
    const batchSize = Math.min(10, Math.max(1, options.batchSize ?? 10));
    const statusFilter = options.status === undefined ? 0 : options.status;
    if (limit === 0) {
      return [];
    }

    const router = this.createRouter(this.provider);
    const count = await this.getCachedTaskCount(router);
    const end = Math.min(count, offset + limit);
    const taskIds = [];
    for (let id = offset; id < end; id++) {
      taskIds.push(id);
    }

    const openTasks: OpenTask[] = [];
    for (let i = 0; i < taskIds.length; i += batchSize) {
      const batch = taskIds.slice(i, i + batchSize);
      const tasks = await Promise.all(
        batch.map(async (id) => ({ id, task: await router.tasks(id) }))
      );

      for (const { id, task } of tasks) {
        const status = Number(task[5]);
        if (statusFilter === null || status === statusFilter) {
          openTasks.push({
            id,
            creator: task[0],
            description: task[2],
            reward: task[3],
            deadline: task[4],
            status,
          });
        }
      }
    }

    return openTasks;
  }

  private async getCachedTaskCount(router: any): Promise<number> {
    const blockNumber = await this.provider.getBlockNumber();
    if (this.taskCountCache?.blockNumber === blockNumber) {
      return this.taskCountCache.count;
    }

    const count = Number(await router.taskCount());
    this.taskCountCache = { blockNumber, count };
    return count;
  }

  private createRouter(runner: ethers.ContractRunner | null): any {
    return this.createContract(
      this.config.routerAddress,
      [
        "function assignTask(uint256,bytes32)",
        "function completeTask(uint256,bytes)",
        "function taskCount() view returns (uint256)",
        "function tasks(uint256) view returns (address,bytes32,string,uint256,uint256,uint8,bytes)",
      ],
      runner
    );
  }

  private createContract(
    address: string,
    abi: string[],
    runner: ethers.ContractRunner | null
  ): any {
    if (this.config.contractFactory) {
      return this.config.contractFactory(address, abi, runner);
    }

    return new ethers.Contract(address, abi, runner);
  }
}
