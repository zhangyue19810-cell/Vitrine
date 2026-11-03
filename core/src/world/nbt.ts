import { gunzipSync, gzipSync, inflateSync } from "node:zlib";

/**
 * NBT reader / writer (Java Edition, big endian). Tags keep their exact type so a file read and written back is
 * identical in meaning: servers.dat and level.dat can be edited without losing fields we do not understand.
 */

export type NbtTypeName = "end" | "byte" | "short" | "int" | "long" | "float" | "double" | "byteArray" | "string" | "list" | "compound" | "intArray" | "longArray";

export type NbtTag =
  | { type: "byte" | "short" | "int" | "float" | "double"; value: number }
  | { type: "long"; value: bigint }
  | { type: "byteArray"; value: Buffer }
  | { type: "string"; value: string }
  | { type: "list"; elementType: NbtTypeName; value: NbtTag[] }
  | { type: "compound"; value: Map<string, NbtTag> }
  | { type: "intArray"; value: number[] }
  | { type: "longArray"; value: bigint[] };

export interface NbtRoot {
  name: string;
  tag: NbtTag;
}

const TYPE_IDS: NbtTypeName[] = ["end", "byte", "short", "int", "long", "float", "double", "byteArray", "string", "list", "compound", "intArray", "longArray"];
const MAX_DEPTH = 512;
export const MAX_NBT_BYTES = 128 * 1024 * 1024;

class Reader {
  position = 0;
  constructor(private readonly buffer: Buffer) {}

  private need(count: number) {
    if (count < 0 || this.position + count > this.buffer.length) throw new Error("NBT data ends unexpectedly");
  }
  u8(): number {
    this.need(1);
    return this.buffer[this.position++];
  }
  i8(): number {
    this.need(1);
    return this.buffer.readInt8(this.position++);
  }
  i16(): number {
    this.need(2);
    const value = this.buffer.readInt16BE(this.position);
    this.position += 2;
    return value;
  }
  u16(): number {
    this.need(2);
    const value = this.buffer.readUInt16BE(this.position);
    this.position += 2;
    return value;
  }
  i32(): number {
    this.need(4);
    const value = this.buffer.readInt32BE(this.position);
    this.position += 4;
    return value;
  }
  i64(): bigint {
    this.need(8);
    const value = this.buffer.readBigInt64BE(this.position);
    this.position += 8;
    return value;
  }
  f32(): number {
    this.need(4);
    const value = this.buffer.readFloatBE(this.position);
    this.position += 4;
    return value;
  }
  f64(): number {
    this.need(8);
    const value = this.buffer.readDoubleBE(this.position);
    this.position += 8;
    return value;
  }
  bytes(count: number): Buffer {
    this.need(count);
    const out = this.buffer.subarray(this.position, this.position + count);
    this.position += count;
    return Buffer.from(out);
  }
  string(): string {
    return decodeModifiedUtf8(this.bytes(this.u16()));
  }
}

/** Java's "modified UTF-8": NUL is C0 80 and characters outside the BMP are stored as two 3-byte surrogates. */
export function decodeModifiedUtf8(bytes: Buffer): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i++];
    if (a < 0x80) out += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0 && i < bytes.length) out += String.fromCharCode(((a & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if ((a & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((a & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else out += "�";
  }
  return out;
}

export function encodeModifiedUtf8(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

function readPayload(reader: Reader, type: NbtTypeName, depth: number): NbtTag {
  if (depth > MAX_DEPTH) throw new Error("NBT is nested too deeply");
  switch (type) {
    case "byte":
      return { type, value: reader.i8() };
    case "short":
      return { type, value: reader.i16() };
    case "int":
      return { type, value: reader.i32() };
    case "long":
      return { type, value: reader.i64() };
    case "float":
      return { type, value: reader.f32() };
    case "double":
      return { type, value: reader.f64() };
    case "byteArray": {
      const length = reader.i32();
      if (length < 0) throw new Error("negative array length");
      return { type, value: reader.bytes(length) };
    }
    case "string":
      return { type, value: reader.string() };
    case "list": {
      const elementId = reader.u8();
      const length = reader.i32();
      if (elementId > 12 || length < 0) throw new Error("invalid NBT list");
      const elementType = TYPE_IDS[elementId];
      if (length > 0 && elementType === "end") throw new Error("invalid NBT list");
      const value: NbtTag[] = [];
      for (let i = 0; i < length; i++) value.push(readPayload(reader, elementType, depth + 1));
      return { type, elementType, value };
    }
    case "compound": {
      const value = new Map<string, NbtTag>();
      while (true) {
        const id = reader.u8();
        if (id === 0) break;
        if (id > 12) throw new Error(`unknown NBT tag type ${id}`);
        const name = reader.string();
        value.set(name, readPayload(reader, TYPE_IDS[id], depth + 1));
      }
      return { type, value };
    }
    case "intArray": {
      const length = reader.i32();
      if (length < 0) throw new Error("negative array length");
      const value: number[] = [];
      for (let i = 0; i < length; i++) value.push(reader.i32());
      return { type, value };
    }
    case "longArray": {
      const length = reader.i32();
      if (length < 0) throw new Error("negative array length");
      const value: bigint[] = [];
      for (let i = 0; i < length; i++) value.push(reader.i64());
      return { type, value };
    }
    default:
      throw new Error(`cannot read NBT type ${type}`);
  }
}

/** Parse NBT, detecting gzip (level.dat), zlib (chunks) or uncompressed data (servers.dat). */
export function parseNbt(input: Buffer): NbtRoot {
  let data = input;
  if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) data = gunzipSync(input, { maxOutputLength: MAX_NBT_BYTES });
  else if (input.length >= 2 && input[0] === 0x78 && (input[0] * 256 + input[1]) % 31 === 0) data = inflateSync(input, { maxOutputLength: MAX_NBT_BYTES });
  const reader = new Reader(data);
  const id = reader.u8();
  if (id !== 10) throw new Error("这不是有效的 NBT 文件（根标签必须是复合标签）");
  const name = reader.string();
  return { name, tag: readPayload(reader, "compound", 0) };
}

class Writer {
  private parts: Buffer[] = [];
  push(buffer: Buffer) {
    this.parts.push(buffer);
  }
  u8(value: number) {
    this.push(Buffer.from([value & 0xff]));
  }
  i16(value: number) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(value);
    this.push(b);
  }
  u16(value: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value);
    this.push(b);
  }
  i32(value: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value);
    this.push(b);
  }
  i64(value: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(value);
    this.push(b);
  }
  f32(value: number) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(value);
    this.push(b);
  }
  f64(value: number) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(value);
    this.push(b);
  }
  string(value: string) {
    const encoded = encodeModifiedUtf8(value);
    if (encoded.length > 0xffff) throw new Error("NBT string is too long");
    this.u16(encoded.length);
    this.push(encoded);
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

const idOf = (type: NbtTypeName) => TYPE_IDS.indexOf(type);

function writePayload(writer: Writer, tag: NbtTag): void {
  switch (tag.type) {
    case "byte":
      writer.u8(tag.value);
      break;
    case "short":
      writer.i16(tag.value);
      break;
    case "int":
      writer.i32(tag.value);
      break;
    case "long":
      writer.i64(tag.value);
      break;
    case "float":
      writer.f32(tag.value);
      break;
    case "double":
      writer.f64(tag.value);
      break;
    case "byteArray":
      writer.i32(tag.value.length);
      writer.push(tag.value);
      break;
    case "string":
      writer.string(tag.value);
      break;
    case "list": {
      const elementType = tag.value.length ? tag.value[0].type : tag.elementType;
      writer.u8(tag.value.length ? idOf(elementType) : idOf(tag.elementType === "end" ? "end" : tag.elementType));
      writer.i32(tag.value.length);
      for (const item of tag.value) {
        if (item.type !== elementType) throw new Error("NBT lists must hold one type of tag");
        writePayload(writer, item);
      }
      break;
    }
    case "compound":
      for (const [name, child] of tag.value) {
        writer.u8(idOf(child.type));
        writer.string(name);
        writePayload(writer, child);
      }
      writer.u8(0);
      break;
    case "intArray":
      writer.i32(tag.value.length);
      for (const item of tag.value) writer.i32(item);
      break;
    case "longArray":
      writer.i32(tag.value.length);
      for (const item of tag.value) writer.i64(item);
      break;
  }
}

export function writeNbt(root: NbtRoot, compression: "none" | "gzip" = "none"): Buffer {
  const writer = new Writer();
  writer.u8(10);
  writer.string(root.name);
  writePayload(writer, root.tag);
  const raw = writer.done();
  return compression === "gzip" ? gzipSync(raw) : raw;
}

// ---------------------------------------------------------------------------------------------- helpers

export const nbt = {
  byte: (value: number): NbtTag => ({ type: "byte", value }),
  short: (value: number): NbtTag => ({ type: "short", value }),
  int: (value: number): NbtTag => ({ type: "int", value }),
  long: (value: bigint): NbtTag => ({ type: "long", value }),
  float: (value: number): NbtTag => ({ type: "float", value }),
  double: (value: number): NbtTag => ({ type: "double", value }),
  string: (value: string): NbtTag => ({ type: "string", value }),
  compound: (value: Record<string, NbtTag> | Map<string, NbtTag> = {}): NbtTag => ({ type: "compound", value: value instanceof Map ? value : new Map(Object.entries(value)) }),
  list: (elementType: NbtTypeName, value: NbtTag[] = []): NbtTag => ({ type: "list", elementType, value }),
};

/** Follow a dotted path through compounds ("Data.Version.Name"). */
export function getTag(tag: NbtTag | undefined, path: string): NbtTag | undefined {
  let current = tag;
  for (const part of path.split(".")) {
    if (!current || current.type !== "compound") return undefined;
    current = current.value.get(part);
  }
  return current;
}

export function getString(tag: NbtTag | undefined, path: string): string | undefined {
  const found = getTag(tag, path);
  return found?.type === "string" ? found.value : undefined;
}

/** Numeric value of a byte / short / int / float / double / long tag. */
export function getNumber(tag: NbtTag | undefined, path: string): number | undefined {
  const found = getTag(tag, path);
  if (!found) return undefined;
  if (found.type === "long") return Number(found.value);
  if (found.type === "byte" || found.type === "short" || found.type === "int" || found.type === "float" || found.type === "double") return found.value;
  return undefined;
}

export function getBigInt(tag: NbtTag | undefined, path: string): bigint | undefined {
  const found = getTag(tag, path);
  return found?.type === "long" ? found.value : undefined;
}

/** Convert to plain JavaScript (longs become bigint, byte arrays Buffers). Handy for debugging and display. */
export function toPlain(tag: NbtTag): unknown {
  switch (tag.type) {
    case "compound":
      return Object.fromEntries([...tag.value].map(([key, value]) => [key, toPlain(value)]));
    case "list":
      return tag.value.map(toPlain);
    default:
      return tag.value;
  }
}
