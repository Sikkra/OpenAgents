/**
 * Contributor traceability:
 * Agent: Codex
 * Platform instructions: private runtime/session material intentionally omitted.
 * Runtime: Windows x64, PowerShell, OpenAgents workspace.
 */

/**
 * ABI encoding/decoding utilities for EVM-compatible contract interactions.
 */

export type AbiType = "uint256" | "int256" | "address" | "bytes32" | "string" | "bool";

export interface AbiParam {
  type: AbiType;
  value: string | number | bigint | boolean;
}

const UINT256_BITS = 256n;
const UINT256_MODULUS = 1n << UINT256_BITS;
const MAX_UINT256 = UINT256_MODULUS - 1n;
const MIN_INT256 = -(1n << 255n);
const MAX_INT256 = (1n << 255n) - 1n;
const WORD_HEX_LENGTH = 64;

function requireBigInt(value: bigint | number, name: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer or bigint`);
  }

  return BigInt(value);
}

function assertInRange(value: bigint, min: bigint, max: bigint, name: string): void {
  if (value < min || value > max) {
    throw new RangeError(`${name} exceeds ABI bounds`);
  }
}

function requireHex(value: string, name: string): string {
  if (!value.startsWith("0x")) {
    throw new Error(`${name} must start with 0x`);
  }

  const hex = value.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${name} contains non-hex characters`);
  }

  return hex;
}

function requireWord(slot: string, name: string): string {
  const hex = requireHex(slot, name);
  if (hex.length > WORD_HEX_LENGTH) {
    throw new RangeError(`${name} exceeds 32 bytes`);
  }

  return hex.padStart(WORD_HEX_LENGTH, "0");
}

function padWord(hex: string): string {
  return hex.padStart(WORD_HEX_LENGTH, "0");
}

export function encodeUint256(value: bigint | number): string {
  const n = requireBigInt(value, "uint256");
  assertInRange(n, 0n, MAX_UINT256, "uint256");
  return padWord(n.toString(16));
}

export function encodeInt256(value: bigint | number): string {
  const n = requireBigInt(value, "int256");
  assertInRange(n, MIN_INT256, MAX_INT256, "int256");

  const twosComplement = n < 0 ? UINT256_MODULUS + n : n;
  return padWord(twosComplement.toString(16));
}

export function encodeAddress(address: string): string {
  const cleaned = requireHex(address, "address");
  if (cleaned.length !== 40) {
    throw new Error("address must be exactly 20 bytes");
  }

  return cleaned.toLowerCase().padStart(WORD_HEX_LENGTH, "0");
}

export function encodeBytes32(data: string): string {
  const cleaned = requireHex(data, "bytes32");
  if (cleaned.length > WORD_HEX_LENGTH) {
    throw new RangeError("bytes32 exceeds 32 bytes");
  }

  return cleaned.padEnd(WORD_HEX_LENGTH, "0");
}

export function encodeBool(value: boolean): string {
  return value ? "1".padStart(WORD_HEX_LENGTH, "0") : "0".padStart(WORD_HEX_LENGTH, "0");
}

export function encodeParams(params: AbiParam[]): string {
  let encoded = "0x";
  for (const param of params) {
    switch (param.type) {
      case "uint256":
        encoded += encodeUint256(param.value as number | bigint);
        break;
      case "int256":
        encoded += encodeInt256(param.value as number | bigint);
        break;
      case "address":
        encoded += encodeAddress(param.value as string);
        break;
      case "bytes32":
        encoded += encodeBytes32(param.value as string);
        break;
      case "bool":
        encoded += encodeBool(param.value as boolean);
        break;
      case "string": {
        const hexStr = Buffer.from(param.value as string).toString("hex");
        encoded += hexStr.padEnd(WORD_HEX_LENGTH, "0");
        break;
      }
    }
  }
  return encoded;
}

export function decodeHex(hex: string): bigint {
  const cleaned = requireHex(hex, "hex");
  return BigInt("0x" + cleaned);
}

export function decodeUint256(slot: string): bigint {
  const word = requireWord(slot, "uint256 slot");
  return BigInt("0x" + word);
}

export function decodeInt256(slot: string): bigint {
  const word = requireWord(slot, "int256 slot");
  const unsigned = BigInt("0x" + word);
  return unsigned >= (1n << 255n) ? unsigned - UINT256_MODULUS : unsigned;
}

export function decodeAddress(slot: string): string {
  const word = requireWord(slot, "address slot");
  return "0x" + word.slice(-40).toLowerCase();
}

export function decodeBool(slot: string): boolean {
  const word = requireWord(slot, "bool slot");
  return BigInt("0x" + word) !== 0n;
}

export function functionSelector(signature: string): string {
  const { createHash } = require("crypto");
  const hash = createHash("sha3-256").update(signature).digest("hex");
  return "0x" + hash.slice(0, 8);
}

export function packCalldata(selector: string, params: AbiParam[]): string {
  const selectorHex = requireHex(selector, "function selector");
  if (selectorHex.length !== 8) {
    throw new Error("function selector must be 4 bytes");
  }

  const encodedParams = encodeParams(params).slice(2);
  return selector + encodedParams;
}
