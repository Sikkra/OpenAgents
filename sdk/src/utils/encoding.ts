/**
 * ABI encoding/decoding utilities for EVM-compatible contract interactions.
 */

export type AbiType =
  | "uint256"
  | "address"
  | "bytes32"
  | "string"
  | "bytes"
  | "bool"
  | `${string}[]`
  | "tuple";

export interface AbiParam {
  type: AbiType;
  value?: string | number | bigint | boolean | unknown[];
  name?: string;
  components?: AbiParam[];
}

export type DecodedValue =
  | bigint
  | string
  | boolean
  | Buffer
  | DecodedValue[]
  | Record<string, DecodedValue>;

export function encodeUint256(value: bigint | number): string {
  const n = BigInt(value);
  return n.toString(16).padStart(64, "0");
}

export function encodeAddress(address: string): string {
  const cleaned = address.startsWith("0x") ? address.slice(2) : address;
  return cleaned.toLowerCase().padStart(64, "0");
}

export function encodeBytes32(data: string): string {
  const cleaned = data.startsWith("0x") ? data.slice(2) : data;
  return cleaned.padEnd(64, "0");
}

export function encodeBool(value: boolean): string {
  return value ? "1".padStart(64, "0") : "0".padStart(64, "0");
}

export function encodeParams(params: AbiParam[]): string {
  let encoded = "0x";
  for (const param of params) {
    switch (param.type) {
      case "uint256":
        encoded += encodeUint256(BigInt(param.value as number));
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
      case "string":
        const hexStr = Buffer.from(param.value as string).toString("hex");
        encoded += hexStr.padEnd(64, "0");
        break;
      default:
        throw new Error(`Unsupported encoding type: ${param.type}`);
    }
  }
  return encoded;
}

export function decodeHex(hex: string): bigint {
  const cleaned = normalizeHex(hex);
  return BigInt("0x" + cleaned);
}

export function decodeUint256(slot: string): bigint {
  return BigInt("0x" + normalizeHex(slot).padStart(64, "0"));
}

export function decodeAddress(slot: string): string {
  const raw = normalizeHex(slot).padStart(64, "0").slice(-40);
  return "0x" + raw.toLowerCase();
}

export function decodeBool(slot: string): boolean {
  return BigInt("0x" + normalizeHex(slot).padStart(64, "0")) !== 0n;
}

export function decodeParameter(param: AbiType | AbiParam, data: string): DecodedValue {
  const descriptor = typeof param === "string" ? { type: param as AbiType } : param;
  const hex = normalizeHex(data);
  if (descriptor.type === "tuple") {
    const offset = Number(readUintWord(hex, 0));
    return isPlausibleOffset(hex, offset)
      ? decodeDynamicAt(descriptor, hex, offset)
      : decodeTuple(descriptor.components ?? [], hex, 0);
  }
  if (isDynamicType(descriptor)) {
    const offset = Number(readUintWord(hex, 0));
    return decodeDynamicAt(descriptor, hex, offset);
  }
  return decodeStaticAt(descriptor, hex, 0);
}

export function decodeParameters(params: AbiParam[], data: string): DecodedValue[] {
  const hex = normalizeHex(data);
  return params.map((param, index) => decodeAt(param, hex, index * 32, 0));
}

function decodeAt(
  param: AbiParam,
  hex: string,
  headOffset: number,
  dynamicBase: number
): DecodedValue {
  if (isDynamicType(param)) {
    const relativeOffset = Number(readUintWord(hex, headOffset));
    return decodeDynamicAt(param, hex, dynamicBase + relativeOffset);
  }
  return decodeStaticAt(param, hex, headOffset);
}

function decodeStaticAt(param: AbiParam, hex: string, offset: number): DecodedValue {
  const word = readWord(hex, offset);
  switch (param.type) {
    case "uint256":
      return decodeUint256(word);
    case "address":
      return decodeAddress(word);
    case "bytes32":
      return "0x" + word;
    case "bool":
      return decodeBool(word);
    default:
      throw new Error(`Type ${param.type} is not statically decodable`);
  }
}

function decodeDynamicAt(param: AbiParam, hex: string, offset: number): DecodedValue {
  if (param.type === "string") {
    return decodeDynamicBytes(hex, offset).toString("utf8");
  }
  if (param.type === "bytes") {
    return decodeDynamicBytes(hex, offset);
  }
  if (param.type.endsWith("[]")) {
    return decodeDynamicArray(param.type.slice(0, -2) as AbiType, hex, offset);
  }
  if (param.type === "tuple") {
    return decodeTuple(param.components ?? [], hex, offset);
  }
  throw new Error(`Type ${param.type} is not dynamically decodable`);
}

function decodeDynamicBytes(hex: string, offset: number): Buffer {
  const length = Number(readUintWord(hex, offset));
  const start = (offset + 32) * 2;
  return Buffer.from(hex.slice(start, start + length * 2), "hex");
}

function decodeDynamicArray(elementType: AbiType, hex: string, offset: number): DecodedValue[] {
  const length = Number(readUintWord(hex, offset));
  const values: DecodedValue[] = [];
  const elementParam: AbiParam = { type: elementType };
  const headStart = offset + 32;

  for (let i = 0; i < length; i++) {
    values.push(decodeAt(elementParam, hex, headStart + i * 32, headStart));
  }
  return values;
}

function decodeTuple(components: AbiParam[], hex: string, offset: number): Record<string, DecodedValue> {
  const decoded: Record<string, DecodedValue> = {};
  components.forEach((component, index) => {
    const key = component.name || String(index);
    decoded[key] = decodeAt(component, hex, offset + index * 32, offset);
  });
  return decoded;
}

function isDynamicType(param: AbiParam): boolean {
  return param.type === "string" || param.type === "bytes" || param.type.endsWith("[]") || param.type === "tuple";
}

function normalizeHex(hex: string): string {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    return "0" + cleaned;
  }
  return cleaned.toLowerCase();
}

function readWord(hex: string, offset: number): string {
  const start = offset * 2;
  const word = hex.slice(start, start + 64);
  if (word.length !== 64) {
    throw new Error("ABI word out of bounds");
  }
  return word;
}

function readUintWord(hex: string, offset: number): bigint {
  return decodeUint256(readWord(hex, offset));
}

function isPlausibleOffset(hex: string, offset: number): boolean {
  return offset >= 32 && offset % 32 === 0 && offset * 2 < hex.length;
}

export function functionSelector(signature: string): string {
  const { createHash } = require("crypto");
  const hash = createHash("sha3-256").update(signature).digest("hex");
  return "0x" + hash.slice(0, 8);
}

export function packCalldata(selector: string, params: AbiParam[]): string {
  const encodedParams = encodeParams(params).slice(2);
  return selector + encodedParams;
}
