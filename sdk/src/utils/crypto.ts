/**
 * @generated-by Codex
 * @timestamp 2026-05-20T05:51:00Z
 * @startup-config private platform/session instructions intentionally omitted
 * @runtime windows/x64, powershell, OpenAgents workspace
 */
import { createHash, pbkdf2Sync, randomBytes } from "crypto";

const { ec: EC } = require("elliptic");
const secp256k1 = new EC("secp256k1");
const DEFAULT_KDF_ITERATIONS = 100_000;
const DEFAULT_KDF_KEY_LENGTH = 32;
const DEFAULT_KDF_DIGEST = "sha256";
const DEFAULT_SALT_BYTES = 16;
const NONCE_BYTES = 16;

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface KdfOptions {
  iterations?: number;
  salt?: string | Buffer;
  keyLength?: number;
  digest?: string;
}

export interface DerivedKey {
  key: Buffer;
  salt: string;
  iterations: number;
  keyLength: number;
  digest: string;
}

export function generateKeyPair(): KeyPair {
  const key = secp256k1.genKeyPair();
  return {
    publicKey: key.getPublic("hex"),
    privateKey: key.getPrivate("hex"),
  };
}

export function keccak256(data: string | Buffer): string {
  const input = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return createHash("sha3-256").update(input).digest("hex");
}

export function generateSalt(byteLength: number = DEFAULT_SALT_BYTES): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < DEFAULT_SALT_BYTES) {
    throw new RangeError(`salt must be at least ${DEFAULT_SALT_BYTES} bytes`);
  }

  return randomBytes(byteLength).toString("hex");
}

export function deriveKey(
  password: string,
  options: KdfOptions = {}
): DerivedKey {
  const iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS;
  const keyLength = options.keyLength ?? DEFAULT_KDF_KEY_LENGTH;
  const digest = options.digest ?? DEFAULT_KDF_DIGEST;
  const salt = normalizeSalt(options.salt ?? generateSalt());

  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new RangeError("iterations must be a positive safe integer");
  }
  if (!Number.isSafeInteger(keyLength) || keyLength <= 0) {
    throw new RangeError("keyLength must be a positive safe integer");
  }

  return {
    key: pbkdf2Sync(password, Buffer.from(salt, "hex"), iterations, keyLength, digest),
    salt,
    iterations,
    keyLength,
    digest,
  };
}

export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex");
}

export function signMessage(privateKey: string, message: string): string {
  const msgHash = keccak256(message);
  const key = secp256k1.keyFromPrivate(privateKey, "hex");
  const signature = key.sign(msgHash);
  return signature.toDER("hex");
}

export function verifySignature(
  publicKey: string,
  message: string,
  signature: string
): boolean {
  if (!isValidDerSignatureHex(signature)) {
    return false;
  }

  const msgHash = keccak256(message);
  try {
    const key = secp256k1.keyFromPublic(publicKey, "hex");
    return key.verify(msgHash, signature);
  } catch {
    return false;
  }
}

export function hashPersonalMessage(message: string): string {
  const prefix = `\x19Ethereum Signed Message:\n${message.length}`;
  return keccak256(prefix + message);
}

export function recoverPublicKey(
  message: string,
  signature: string,
  recoveryParam: number
): string {
  if (!isValidDerSignatureHex(signature)) {
    throw new Error("Invalid DER signature");
  }

  const msgHash = Buffer.from(keccak256(message), "hex");
  const recovered = secp256k1.recoverPubKey(msgHash, signature, recoveryParam);
  return recovered.encode("hex", false);
}

function normalizeSalt(salt: string | Buffer): string {
  const saltHex = Buffer.isBuffer(salt)
    ? salt.toString("hex")
    : salt.startsWith("0x")
      ? salt.slice(2)
      : salt;

  if (!/^[0-9a-fA-F]+$/.test(saltHex) || saltHex.length % 2 !== 0) {
    throw new Error("salt must be even-length hex");
  }
  if (saltHex.length < DEFAULT_SALT_BYTES * 2) {
    throw new RangeError(`salt must be at least ${DEFAULT_SALT_BYTES} bytes`);
  }

  return saltHex.toLowerCase();
}

function isValidDerSignatureHex(signature: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(signature) || signature.length % 2 !== 0) {
    return false;
  }

  const bytes = Buffer.from(signature, "hex");
  if (bytes.length < 8 || bytes.length > 72) {
    return false;
  }

  return bytes[0] === 0x30 && bytes[1] === bytes.length - 2;
}
