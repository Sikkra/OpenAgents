/**
 * @contributor sikkra-codex-crypto-hardening
 * @timestamp 2026-05-20T08:00:00Z
 * @platform-config Private platform/session initialization text intentionally omitted.
 * @env os=windows; arch=x64; home_dir=C:\Users\Ben; working_dir=D:\Documents\AI Projects\Wallet\bounty-work\OpenAgents; shell=powershell
 */

import { createHash, pbkdf2Sync, randomBytes } from "crypto";
import { ec as EC } from "elliptic";

const secp256k1 = new EC("secp256k1");
const DEFAULT_KDF_ITERATIONS = 100_000;
const MIN_KDF_ITERATIONS = 10_000;
const DEFAULT_KDF_KEY_LENGTH = 32;
const DEFAULT_KDF_DIGEST = "sha256";
const DEFAULT_SALT_BYTES = 16;
const DEFAULT_NONCE_BYTES = 16;
const MIN_DER_SIGNATURE_HEX_LENGTH = 16;
const MAX_DER_SIGNATURE_HEX_LENGTH = 144;
const HEX_PATTERN = /^[0-9a-f]+$/i;

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface DeriveKeyOptions {
  iterations?: number;
  salt?: Buffer | string;
  keyLength?: number;
  digest?: string;
}

export interface DerivedKey {
  key: Buffer;
  salt: string;
  iterations: number;
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

export function generateSalt(size = DEFAULT_SALT_BYTES): Buffer {
  if (!Number.isInteger(size) || size < DEFAULT_SALT_BYTES) {
    throw new Error(`Salt must be at least ${DEFAULT_SALT_BYTES} bytes`);
  }
  return randomBytes(size);
}

function normalizeSalt(salt?: Buffer | string): Buffer {
  if (!salt) {
    return generateSalt();
  }
  if (Buffer.isBuffer(salt)) {
    if (salt.length < DEFAULT_SALT_BYTES) {
      throw new Error(`Salt must be at least ${DEFAULT_SALT_BYTES} bytes`);
    }
    return Buffer.from(salt);
  }
  if (!HEX_PATTERN.test(salt) || salt.length < DEFAULT_SALT_BYTES * 2 || salt.length % 2 !== 0) {
    throw new Error(`Salt must be a hex string at least ${DEFAULT_SALT_BYTES * 2} characters long`);
  }
  return Buffer.from(salt, "hex");
}

export function deriveKey(password: string, options: DeriveKeyOptions | number = {}): DerivedKey {
  const resolved = typeof options === "number" ? { iterations: options } : options;
  const iterations = resolved.iterations ?? DEFAULT_KDF_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS) {
    throw new Error(`KDF iterations must be at least ${MIN_KDF_ITERATIONS}`);
  }

  const keyLength = resolved.keyLength ?? DEFAULT_KDF_KEY_LENGTH;
  const digest = resolved.digest ?? DEFAULT_KDF_DIGEST;
  const salt = normalizeSalt(resolved.salt);
  return {
    key: pbkdf2Sync(password, salt, iterations, keyLength, digest),
    salt: salt.toString("hex"),
    iterations,
    digest,
  };
}

export function generateNonce(size = DEFAULT_NONCE_BYTES): string {
  if (!Number.isInteger(size) || size < DEFAULT_NONCE_BYTES) {
    throw new Error(`Nonce must be at least ${DEFAULT_NONCE_BYTES} bytes`);
  }
  return randomBytes(size).toString("hex");
}

function isValidDerSignatureHex(signature: string): boolean {
  return (
    signature.length >= MIN_DER_SIGNATURE_HEX_LENGTH &&
    signature.length <= MAX_DER_SIGNATURE_HEX_LENGTH &&
    signature.length % 2 === 0 &&
    HEX_PATTERN.test(signature)
  );
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
  const msgHash = Buffer.from(keccak256(message), "hex");
  const recovered = secp256k1.recoverPubKey(msgHash, signature, recoveryParam);
  return recovered.encode("hex", false);
}
