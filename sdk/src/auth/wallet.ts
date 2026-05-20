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
}

export interface SignedTransaction {
  raw: string;
  hash: string;
}

type KeyStore = {
  read: () => Buffer;
  destroy: () => void;
};

export class Wallet {
  public readonly address: string;
  private readonly readPrivateKey: () => Buffer;
  private readonly destroyPrivateKey: () => void;
  private provider: RpcProvider;
  private cachedNonce: number | null = null;

  constructor(config: WalletConfig) {
    const privateKey = Wallet.normalizePrivateKey(
      config.privateKey ?? generateKeyPair().privateKey
    );
    const keyStore = Wallet.createKeyStore(privateKey);

    this.readPrivateKey = keyStore.read;
    this.destroyPrivateKey = keyStore.destroy;
    this.address = this.deriveAddress(this.readPrivateKey());
    this.provider = config.provider;
  }

  private static normalizePrivateKey(privateKey: string): string {
    const cleaned = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
      throw new Error("Wallet: invalid private key");
    }
    return cleaned.toLowerCase();
  }

  private static createKeyStore(privateKey: string): KeyStore {
    const keyBytes = Buffer.from(privateKey, "hex");
    return {
      read: () => Buffer.from(keyBytes),
      destroy: () => keyBytes.fill(0),
    };
  }

  private deriveAddress(privateKey: Buffer): string {
    try {
      const { ec: EC } = require("elliptic");
      const curve = new EC("secp256k1");
      const key = curve.keyFromPrivate(privateKey.toString("hex"), "hex");
      const pubKey = key.getPublic(false, "hex").slice(2);
      const hash = keccak256(Buffer.from(pubKey, "hex"));
      return "0x" + hash.slice(-40);
    } finally {
      privateKey.fill(0);
    }
  }

  private async validateChainId(txChainId?: number): Promise<number> {
    const configuredChainId = this.provider.getChainId();
    const rpcChainIdHex = (await this.provider.call("eth_chainId")) as string;
    const rpcChainId = Number.parseInt(rpcChainIdHex, 16);

    if (!Number.isSafeInteger(rpcChainId) || rpcChainId <= 0) {
      throw new Error("Wallet: invalid RPC chain ID");
    }
    if (rpcChainId !== configuredChainId) {
      throw new Error("Wallet: provider chain ID mismatch");
    }
    if (txChainId !== undefined && txChainId !== configuredChainId) {
      throw new Error("Wallet: transaction chain ID mismatch");
    }
    return txChainId ?? configuredChainId;
  }

  async signTransaction(tx: Transaction): Promise<SignedTransaction> {
    const chainId = await this.validateChainId(tx.chainId);
    const nonce = tx.nonce ?? await this.getNonce();
    const gasPrice = tx.gasPrice ?? BigInt(await this.provider.call("eth_gasPrice") as string);

    const txData = encodeParams([
      { type: "uint256", value: nonce } as AbiParam,
      { type: "uint256", value: chainId } as AbiParam,
      { type: "uint256", value: gasPrice } as AbiParam,
      { type: "uint256", value: tx.gasLimit } as AbiParam,
      { type: "address", value: tx.to } as AbiParam,
      { type: "uint256", value: tx.value } as AbiParam,
    ]);

    const txHash = keccak256(txData);
    const privateKey = this.readPrivateKey();
    let signature: string;
    try {
      signature = signMessage(privateKey.toString("hex"), txHash);
    } finally {
      privateKey.fill(0);
    }

    return {
      raw: "0x" + txData.slice(2) + signature,
      hash: "0x" + txHash,
    };
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
    const signed = await this.signTransaction(tx);
    return (await this.provider.call("eth_sendRawTransaction", [signed.raw])) as string;
  }

  exportPrivateKey(): string {
    const privateKey = this.readPrivateKey();
    try {
      return privateKey.toString("hex");
    } finally {
      privateKey.fill(0);
    }
  }

  destroy(): void {
    this.destroyPrivateKey();
    this.cachedNonce = null;
  }
}
