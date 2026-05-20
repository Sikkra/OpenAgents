/**
 * @contributor: Codex
 * @timestamp: 2026-05-20T02:04:54.1491836-05:00
 * @platform-config: private platform/session initialization text intentionally omitted
 * @runtime: os=windows, arch=x64, home_dir=C:\Users\Ben, working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents, shell=powershell
 */

import { generateKeyPair, signMessage, keccak256 } from "../utils/crypto";
import { encodeParams, AbiParam } from "../utils/encoding";
import { RpcProvider } from "../providers/rpc";

export interface WalletConfig {
  privateKey?: string;
  provider: RpcProvider;
}

export interface Transaction {
  to: string;
  value: bigint;
  data: string;
  gasLimit: bigint;
  gasPrice?: bigint;
  nonce?: number;
  chainId?: number;
  skipSimulation?: boolean;
}

export interface SignedTransaction {
  raw: string;
  hash: string;
}

export class TransactionSimulationError extends Error {
  readonly reason: string;
  readonly revertData?: string;

  constructor(reason: string, revertData?: string) {
    super(`Transaction simulation failed: ${reason}`);
    this.name = "TransactionSimulationError";
    this.reason = reason;
    this.revertData = revertData;
  }
}

export class Wallet {
  public readonly address: string;
  private privateKey: string;
  private provider: RpcProvider;
  private cachedNonce: number | null = null;
  private simulationCacheBlock: number | null = null;
  private simulationCache = new Set<string>();

  constructor(config: WalletConfig) {
    if (config.privateKey) {
      this.privateKey = config.privateKey;
    } else {
      const keyPair = generateKeyPair();
      this.privateKey = keyPair.privateKey;
    }
    this.address = this.deriveAddress(this.privateKey);
    this.provider = config.provider;
  }

  private deriveAddress(privateKey: string): string {
    const { ec: EC } = require("elliptic");
    const curve = new EC("secp256k1");
    const key = curve.keyFromPrivate(privateKey, "hex");
    const pubKey = key.getPublic(false, "hex").slice(2); // remove 04 prefix
    const hash = keccak256(Buffer.from(pubKey, "hex"));
    return "0x" + hash.slice(-40);
  }

  async signTransaction(tx: Transaction): Promise<SignedTransaction> {
    const nonce = tx.nonce ?? await this.getNonce();
    const gasPrice = tx.gasPrice ?? BigInt(await this.provider.call("eth_gasPrice") as string);

    const txData = encodeParams([
      { type: "uint256", value: nonce } as AbiParam,
      { type: "uint256", value: gasPrice } as AbiParam,
      { type: "uint256", value: tx.gasLimit } as AbiParam,
      { type: "address", value: tx.to } as AbiParam,
      { type: "uint256", value: tx.value } as AbiParam,
    ]);

    const txHash = keccak256(txData);
    const signature = signMessage(this.privateKey, txHash);

    return {
      raw: "0x" + txData.slice(2) + signature,
      hash: "0x" + txHash,
    };
  }

  async simulateTransaction(tx: Transaction): Promise<void> {
    const blockNumber = await this.provider.getBlockNumber();
    if (this.simulationCacheBlock !== blockNumber) {
      this.simulationCacheBlock = blockNumber;
      this.simulationCache.clear();
    }

    const rpcTx = this.toRpcTransaction(tx);
    const cacheKey = JSON.stringify(rpcTx);
    if (this.simulationCache.has(cacheKey)) {
      return;
    }

    try {
      await this.provider.call("eth_call", [rpcTx, "latest"]);
      this.simulationCache.add(cacheKey);
    } catch (error) {
      const revertData = this.extractRevertData(error);
      const reason = this.decodeRevertReason(revertData) ?? this.errorMessage(error);
      throw new TransactionSimulationError(reason, revertData);
    }
  }

  private toRpcTransaction(tx: Transaction): Record<string, string> {
    const rpcTx: Record<string, string> = {
      from: this.address,
      to: tx.to,
      value: "0x" + tx.value.toString(16),
      data: tx.data || "0x",
      gas: "0x" + tx.gasLimit.toString(16),
    };
    if (tx.gasPrice !== undefined) {
      rpcTx.gasPrice = "0x" + tx.gasPrice.toString(16);
    }
    if (tx.nonce !== undefined) {
      rpcTx.nonce = "0x" + tx.nonce.toString(16);
    }
    return rpcTx;
  }

  private extractRevertData(error: unknown): string | undefined {
    const candidates = [
      (error as any)?.data,
      (error as any)?.error?.data,
      (error as any)?.info?.error?.data,
      (error as any)?.body,
      (error as Error)?.message,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string") {
        const match = candidate.match(/0x[0-9a-fA-F]{8,}/);
        if (match) {
          return match[0];
        }
      } else if (candidate && typeof candidate === "object") {
        const nested = this.extractRevertData(candidate);
        if (nested) {
          return nested;
        }
      }
    }

    return undefined;
  }

  private decodeRevertReason(data?: string): string | undefined {
    if (!data?.startsWith("0x")) {
      return undefined;
    }

    const hex = data.slice(2);
    if (hex.startsWith("08c379a0") && hex.length >= 8 + 64 + 64) {
      const lengthHex = hex.slice(8 + 64, 8 + 128);
      const length = Number(BigInt("0x" + lengthHex));
      const reasonHex = hex.slice(8 + 128, 8 + 128 + length * 2);
      return Buffer.from(reasonHex, "hex").toString("utf8");
    }

    if (hex.startsWith("4e487b71") && hex.length >= 8 + 64) {
      const panicCode = BigInt("0x" + hex.slice(8, 8 + 64));
      return `Panic(0x${panicCode.toString(16)})`;
    }

    return undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async getNonce(): Promise<number> {
    if (this.cachedNonce !== null) {
      return this.cachedNonce++;
    }
    const hex = (await this.provider.call("eth_getTransactionCount", [
      this.address,
      "latest",
    ])) as string;
    this.cachedNonce = parseInt(hex, 16);
    return this.cachedNonce++;
  }

  async getBalance(): Promise<bigint> {
    return this.provider.getBalance(this.address);
  }

  async sendTransaction(tx: Transaction): Promise<string> {
    if (!tx.skipSimulation) {
      await this.simulateTransaction(tx);
    }
    const signed = await this.signTransaction(tx);
    return (await this.provider.call("eth_sendRawTransaction", [signed.raw])) as string;
  }

  exportPrivateKey(): string {
    return this.privateKey;
  }
}
