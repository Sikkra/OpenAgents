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
  gasLimit?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasMarginBps?: number;
  nonce?: number;
  chainId?: number;
}

export interface SignedTransaction {
  raw: string;
  hash: string;
}

interface ResolvedFeeData {
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

const DEFAULT_GAS_MARGIN_BPS = 2_000;
const BPS_DENOMINATOR = 10_000n;

export class Wallet {
  // BUG: Private key stored as plaintext string in memory — should use
  // a secure enclave, encrypted storage, or at minimum a Buffer that can be zeroed
  public readonly address: string;
  private privateKey: string;
  private provider: RpcProvider;
  private cachedNonce: number | null = null;

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
    // BUG: No chain ID validation — transaction could be replayed on a different
    // chain if chainId is missing or mismatched with the provider
    const nonce = tx.nonce ?? await this.getNonce();
    const gasLimit = tx.gasLimit ?? await this.estimateGasLimit(tx);
    const feeData = await this.resolveFeeData(tx);

    const txData = encodeParams([
      { type: "uint256", value: nonce } as AbiParam,
      { type: "uint256", value: feeData.gasPrice } as AbiParam,
      { type: "uint256", value: feeData.maxFeePerGas } as AbiParam,
      { type: "uint256", value: feeData.maxPriorityFeePerGas } as AbiParam,
      { type: "uint256", value: gasLimit } as AbiParam,
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

  async estimateGasLimit(tx: Transaction): Promise<bigint> {
    const estimate = BigInt(await this.provider.call("eth_estimateGas", [
      this.toRpcTransaction(tx),
    ]) as string);
    const marginBps = BigInt(Math.max(0, tx.gasMarginBps ?? DEFAULT_GAS_MARGIN_BPS));
    const withMargin = (estimate * (BPS_DENOMINATOR + marginBps)) / BPS_DENOMINATOR;
    const blockGasLimit = await this.getLatestBlockGasLimit();
    return withMargin > blockGasLimit ? blockGasLimit : withMargin;
  }

  private async resolveFeeData(tx: Transaction): Promise<ResolvedFeeData> {
    if (tx.gasPrice !== undefined) {
      return {
        gasPrice: tx.gasPrice,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
      };
    }

    const latestBlock = await this.getLatestBlock();
    const baseFee = latestBlock?.baseFeePerGas ? BigInt(latestBlock.baseFeePerGas) : null;
    if (baseFee !== null) {
      const priorityFee = tx.maxPriorityFeePerGas ?? BigInt(
        await this.provider.call("eth_maxPriorityFeePerGas") as string
      );
      return {
        gasPrice: 0n,
        maxFeePerGas: tx.maxFeePerGas ?? baseFee * 2n + priorityFee,
        maxPriorityFeePerGas: priorityFee,
      };
    }

    return {
      gasPrice: BigInt(await this.provider.call("eth_gasPrice") as string),
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    };
  }

  private async getLatestBlockGasLimit(): Promise<bigint> {
    const latestBlock = await this.getLatestBlock();
    return latestBlock?.gasLimit ? BigInt(latestBlock.gasLimit) : 30_000_000n;
  }

  private async getLatestBlock(): Promise<{ gasLimit?: string; baseFeePerGas?: string } | null> {
    const block = await this.provider.call("eth_getBlockByNumber", ["latest", false]);
    return typeof block === "object" && block !== null
      ? block as { gasLimit?: string; baseFeePerGas?: string }
      : null;
  }

  private toRpcTransaction(tx: Transaction): Record<string, string> {
    return {
      from: this.address,
      to: tx.to,
      value: "0x" + tx.value.toString(16),
      data: tx.data || "0x",
    };
  }

  async getNonce(): Promise<number> {
    // BUG: Uses cached nonce instead of fetching fresh from chain —
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
