/**
 * The bounded Variant subset Godot's remote debugger speaks on the wire.
 *
 * Debugger packets are `[uint32 length][Variant]`, and every Variant the
 * profiler stream carries is a nil/bool/int/float/string/array or a packed
 * numeric array. Objects, dictionaries and vectors are deliberately *not*
 * decoded: an unrelated debugger packet must fail loudly instead of driving
 * allocation from an attacker-shaped length field. Callers treat a decode
 * failure as "not a message I care about" and move on.
 *
 * 来源:Erodenn-godot-mcp-runtime/src/utils/godot-variant.ts 整文件移植 [上游 license:MIT,2026-10-01 GitHub API 核实,见 THIRD_PARTY_NOTICES.md]
 * (2026-09-11 P2 批,函数级 profiling 尽调;原文件零依赖,除本注释外逐行一致)。
 */

/** Every value this codec can represent. */
export type Variant = null | boolean | number | string | Variant[];

/** Matches the engine's own debugger packet ceiling. */
export const MAX_PACKET_BYTES = 16 * 1024 * 1024;

const TYPE_NIL = 0;
const TYPE_BOOL = 1;
const TYPE_INT = 2;
const TYPE_FLOAT = 3;
const TYPE_STRING = 4;
const TYPE_STRING_NAME = 21;
const TYPE_ARRAY = 28;
const TYPE_PACKED_BYTE_ARRAY = 29;
const TYPE_PACKED_INT32_ARRAY = 30;
const TYPE_PACKED_INT64_ARRAY = 31;
const TYPE_PACKED_FLOAT32_ARRAY = 32;
const TYPE_PACKED_FLOAT64_ARRAY = 33;
const TYPE_PACKED_STRING_ARRAY = 34;

// Bit 16 of the header word marks the 64-bit encoding of INT and FLOAT.
const FLAG_WIDE = 1 << 16;
const MAX_NESTING = 64;

const padding = (length: number): number => (4 - (length % 4)) % 4;

/**
 * Encode one outgoing debugger command. Only the types the debugger accepts
 * from us are supported — anything else is a bug in the caller, not a packet
 * we should try to serialize.
 */
export function encodeVariant(value: Variant): Buffer {
  if (value === null) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(TYPE_NIL, 0);
    return buf;
  }
  if (typeof value === 'boolean') {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(TYPE_BOOL, 0);
    buf.writeUInt32LE(value ? 1 : 0, 4);
    return buf;
  }
  if (typeof value === 'number') {
    const buf = Buffer.alloc(12);
    if (Number.isInteger(value)) {
      buf.writeUInt32LE(TYPE_INT | FLAG_WIDE, 0);
      buf.writeBigInt64LE(BigInt(value), 4);
    } else {
      buf.writeUInt32LE(TYPE_FLOAT | FLAG_WIDE, 0);
      buf.writeDoubleLE(value, 4);
    }
    return buf;
  }
  if (typeof value === 'string') {
    const raw = Buffer.from(value, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32LE(TYPE_STRING, 0);
    head.writeUInt32LE(raw.length, 4);
    return Buffer.concat([head, raw, Buffer.alloc(padding(raw.length))]);
  }
  if (Array.isArray(value)) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(TYPE_ARRAY, 0);
    head.writeUInt32LE(value.length, 4);
    return Buffer.concat([head, ...value.map(encodeVariant)]);
  }
  throw new Error('Unsupported outgoing debugger value');
}

/**
 * Decode one incoming packet payload. Throws on truncation, trailing bytes,
 * or a type outside the supported subset.
 */
export function decodeVariant(raw: Buffer): Variant {
  let offset = 0;

  const take = (size: number, read: (buf: Buffer, at: number) => number): number => {
    if (offset + size > raw.length) throw new Error('Truncated Variant');
    const value = read(raw, offset);
    offset += size;
    return value;
  };
  const u32 = (): number => take(4, (buf, at) => buf.readUInt32LE(at));
  const readString = (): string => {
    const size = u32();
    const end = offset + size;
    if (end + padding(size) > raw.length) throw new Error('Truncated string');
    const value = raw.toString('utf8', offset, end);
    offset = end + padding(size);
    return value;
  };

  const item = (depth: number): Variant => {
    if (depth > MAX_NESTING) throw new Error('Variant nesting limit');
    const header = u32();
    const kind = header & 0xffff;
    const wide = (header & FLAG_WIDE) !== 0;
    switch (kind) {
      case TYPE_NIL:
        return null;
      case TYPE_BOOL:
        return u32() !== 0;
      case TYPE_INT:
        return wide
          ? Number(take(8, (buf, at) => Number(buf.readBigInt64LE(at))))
          : take(4, (buf, at) => buf.readInt32LE(at));
      case TYPE_FLOAT:
        return wide
          ? take(8, (buf, at) => buf.readDoubleLE(at))
          : take(4, (buf, at) => buf.readFloatLE(at));
      case TYPE_STRING:
      case TYPE_STRING_NAME:
        return readString();
      case TYPE_PACKED_BYTE_ARRAY:
      case TYPE_PACKED_INT32_ARRAY:
      case TYPE_PACKED_INT64_ARRAY:
      case TYPE_PACKED_FLOAT32_ARRAY:
      case TYPE_PACKED_FLOAT64_ARRAY: {
        const reader = PACKED_READERS[kind];
        if (reader === undefined) throw new Error(`Unsupported debugger Variant ${header}`);
        const [size, read] = reader;
        const count = u32();
        if (count > (raw.length - offset) / size) throw new Error('Invalid packed array length');
        const values: Variant[] = [];
        for (let i = 0; i < count; i++) values.push(take(size, read));
        if (kind === TYPE_PACKED_BYTE_ARRAY) offset += padding(count);
        return values;
      }
      case TYPE_ARRAY:
      case TYPE_PACKED_STRING_ARRAY: {
        // A typed (or shared) array sets flags we do not carry through.
        if (header !== kind) throw new Error(`Unsupported debugger Variant ${header}`);
        const count = u32() & 0x7fffffff;
        if (count > (raw.length - offset) / 4) throw new Error('Invalid array length');
        const values: Variant[] = [];
        for (let i = 0; i < count; i++) {
          values.push(kind === TYPE_ARRAY ? item(depth + 1) : readString());
        }
        return values;
      }
      default:
        throw new Error(`Unsupported debugger Variant ${header}`);
    }
  };

  const value = item(0);
  if (offset !== raw.length) throw new Error('Trailing Variant bytes');
  return value;
}

const PACKED_READERS: Record<number, [number, (buf: Buffer, at: number) => number]> = {
  [TYPE_PACKED_BYTE_ARRAY]: [1, (buf, at) => buf.readUInt8(at)],
  [TYPE_PACKED_INT32_ARRAY]: [4, (buf, at) => buf.readInt32LE(at)],
  [TYPE_PACKED_INT64_ARRAY]: [8, (buf, at) => Number(buf.readBigInt64LE(at))],
  [TYPE_PACKED_FLOAT32_ARRAY]: [4, (buf, at) => buf.readFloatLE(at)],
  [TYPE_PACKED_FLOAT64_ARRAY]: [8, (buf, at) => buf.readDoubleLE(at)],
};
