/**
 * @fix-author: Codex
 * @date: 2026-05-20T06:11:28Z
 * @runtime: windows/x64, working_dir=D:\\Documents\\AI Projects\\Wallet\\bounty-work\\OpenAgents, shell=powershell
 * @note: Private platform/session initialization payload intentionally omitted.
 */

import { Wallet as EthersWallet, keccak256 as hashRawTransaction } from "ethers";
import { randomBytes } from "crypto";
import { RpcProvider } from "../providers/rpc";

export interface WalletConfig {
  privateKey?: string;
  provider: RpcProvider;
}

export interface AccessListEntry {
  address: string;
  storageKeys: string[];
}

export interface Transaction {
  to: string;
  value: bigint;
  data: string;
  gasLimit: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  chainId?: number;
  type?: 0 | 1 | 2;
  accessList?: AccessListEntry[];
}

export interface SignedTransaction {
  raw: string;
  hash: string;
}

export class Wallet {
  public readonly address: string;
  private privateKey: string;
  private provider: RpcProvider;
  private cachedNonce: number | null = null;

  constructor(config: WalletConfig) {
    this.privateKey = Wallet.normalizePrivateKey(
      config.privateKey ?? randomBytes(32).toString("hex")
    );
    this.address = new EthersWallet(Wallet.withHexPrefix(this.privateKey)).address;
    this.provider = config.provider;
  }

  private static normalizePrivateKey(privateKey: string): string {
    const cleaned = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    if (!/^[0-9a-fA-F]{1,64}$/.test(cleaned)) {
      throw new Error("Wallet: invalid private key");
    }
    return cleaned.padStart(64, "0").toLowerCase();
  }

  private static withHexPrefix(value: string): string {
    return value.startsWith("0x") ? value : `0x${value}`;
  }

  async signTransaction(tx: Transaction): Promise<SignedTransaction> {
    const nonce = tx.nonce ?? await this.getNonce();
    const chainId = tx.chainId ?? this.provider.getChainId();
    const signer = new EthersWallet(Wallet.withHexPrefix(this.privateKey));
    const request = await this.buildSerializableTransaction(tx, nonce, chainId);
    const raw = await signer.signTransaction(request);

    return {
      raw,
      hash: hashRawTransaction(raw),
    };
  }

  private async buildSerializableTransaction(
    tx: Transaction,
    nonce: number,
    chainId: number
  ): Promise<Record<string, unknown>> {
    const base = {
      to: tx.to,
      value: tx.value,
      data: tx.data || "0x",
      gasLimit: tx.gasLimit,
      nonce,
      chainId,
    };

    if (this.shouldUseEip1559(tx)) {
      if (tx.gasPrice !== undefined) {
        throw new Error("Wallet: gasPrice cannot be mixed with EIP-1559 fee fields");
      }
      const fees = await this.resolveEip1559Fees(tx);
      return {
        ...base,
        type: 2,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        accessList: tx.accessList ?? [],
      };
    }

    return {
      ...base,
      type: tx.type ?? 0,
      gasPrice: tx.gasPrice ?? BigInt(await this.provider.call("eth_gasPrice") as string),
    };
  }

  private shouldUseEip1559(tx: Transaction): boolean {
    if (tx.type === 2) {
      return true;
    }
    if (tx.type === 0 || tx.type === 1) {
      return false;
    }
    if (tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined) {
      return true;
    }
    return tx.gasPrice === undefined;
  }

  private async resolveEip1559Fees(tx: Transaction): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }> {
    const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? await this.getPriorityFeePerGas();
    const maxFeePerGas = tx.maxFeePerGas ?? await this.getMaxFeePerGas(maxPriorityFeePerGas);

    if (maxFeePerGas < maxPriorityFeePerGas) {
      throw new Error("Wallet: maxFeePerGas must be >= maxPriorityFeePerGas");
    }

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  private async getPriorityFeePerGas(): Promise<bigint> {
    try {
      return BigInt(await this.provider.call("eth_maxPriorityFeePerGas") as string);
    } catch {
      const gasPrice = BigInt(await this.provider.call("eth_gasPrice") as string);
      return gasPrice / 10n;
    }
  }

  private async getMaxFeePerGas(priorityFee: bigint): Promise<bigint> {
    const latestBlock = await this.provider.call("eth_getBlockByNumber", ["latest", false]) as {
      baseFeePerGas?: string;
    } | null;

    if (latestBlock?.baseFeePerGas) {
      return BigInt(latestBlock.baseFeePerGas) * 2n + priorityFee;
    }

    return BigInt(await this.provider.call("eth_gasPrice") as string) + priorityFee;
  }

  async getNonce(): Promise<number> {
    // BUG: Uses cached nonce instead of fetching fresh from chain -
    // stale nonce causes "nonce too low" errors after external transactions
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
    const signed = await this.signTransaction(tx);
    return (await this.provider.call("eth_sendRawTransaction", [signed.raw])) as string;
  }

  exportPrivateKey(): string {
    return this.privateKey;
  }
}
