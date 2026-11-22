/**
 * A small QR code encoder (byte mode, error correction level M, versions 1 to 10: up to 213 bytes) for the music login.
 * The structure follows the ISO/IEC 18004 steps one by one (data bits → Reed–Solomon blocks → interleave → function
 * patterns → mask with the lowest penalty → format and version bits); it exists so that the login code can be drawn
 * on the 3D archive without a library. Its structure is covered by the unit tests (`core/test/rail.test.ts`); its output was
 * also decoded with an independent decoder (jsQR, not a dependency of this project) on text from 1 to 213 bytes.
 */

// Index = version (0 unused): error correction codewords per block and number of blocks, level M.
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const QR_MAX_BYTES = 213;

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2;
    result -= (25 * aligns - 10) * aligns - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version: number) => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];

// ------------------------------------------------------------------------------------------------ Reed–Solomon over GF(256)

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function generator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function remainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coefficient, i) => (result[i] ^= gfMultiply(coefficient, factor)));
  }
  return result;
}

// ------------------------------------------------------------------------------------------------ building the symbol

const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0;

export interface QrSymbol {
  size: number;
  version: number;
  mask: number;
  /** modules[y][x]: true is dark. */
  modules: boolean[][];
}

export function encodeQr(text: string): QrSymbol {
  const bytes = Array.from(new TextEncoder().encode(text));
  // The smallest version that holds the text: 4 mode bits + 8 count bits (versions 1–9) or 16 (10) + the bytes.
  let version = 1;
  for (; version <= 10; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break;
  }
  if (version > 10) throw new RangeError(`text is too long for the QR encoder (${bytes.length} bytes, at most ${QR_MAX_BYTES})`);

  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // Split into blocks, add each block's error correction, interleave.
  const blocks = BLOCKS[version];
  const eccLength = ECC_PER_BLOCK[version];
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (totalCodewords % blocks);
  const shortLength = Math.floor(totalCodewords / blocks) - eccLength;
  const divisor = generator(eccLength);
  const split: { data: number[]; ecc: number[] }[] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const part = data.slice(k, k + length);
    k += length;
    split.push({ data: part, ecc: remainder(part, divisor) });
  }
  const codewords: number[] = [];
  for (let i = 0; i <= shortLength; i++) for (const block of split) if (i < block.data.length) codewords.push(block.data[i]);
  for (let i = 0; i < eccLength; i++) for (const block of split) codewords.push(block.ecc[i]);

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // Function patterns: timing, finders with their separators, alignment patterns, the reserved format area, the dark module.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const aligns = alignmentPositions(version, size);
  for (let i = 0; i < aligns.length; i++) {
    for (let j = 0; j < aligns.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === aligns.length - 1) || (i === aligns.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(aligns[i] + dx, aligns[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[size - 11 + j][i] = true;
        reserved[i][size - 11 + j] = true;
      }
    }
  }
  set(8, size - 8, true);

  // The codewords snake up and down pairs of columns, skipping the timing column.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!reserved[y][x] && index < codewords.length * 8) {
          modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7));
          index++;
        }
      }
    }
  }

  // Try every mask and keep the one with the lowest penalty.
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, reserved, mask);
    drawFormat(modules, size, mask);
    if (version >= 7) drawVersion(modules, size, version);
    const score = penalty(modules, size);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(modules, reserved, mask); // masking twice restores the data modules
  }
  applyMask(modules, reserved, best);
  drawFormat(modules, size, best);
  if (version >= 7) drawVersion(modules, size, version);
  return { size, version, mask: best, modules };
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(modules: boolean[][], reserved: boolean[][], mask: number) {
  const size = modules.length;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
}

function drawFormat(modules: boolean[][], size: number, mask: number) {
  // Level M is 00; BCH(15,5) with the generator 0x537, then XOR 0x5412.
  const data = (0b00 << 3) | mask;
  let remainderBits = data;
  for (let i = 0; i < 10; i++) remainderBits = (remainderBits << 1) ^ ((remainderBits >>> 9) * 0x537);
  const bits = ((data << 10) | remainderBits) ^ 0x5412;
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(bits, i);
  modules[7][8] = bit(bits, 6);
  modules[8][8] = bit(bits, 7);
  modules[8][7] = bit(bits, 8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(bits, i);
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(bits, i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(bits, i);
  modules[size - 8][8] = true;
}

function drawVersion(modules: boolean[][], size: number, version: number) {
  let remainderBits = version;
  for (let i = 0; i < 12; i++) remainderBits = (remainderBits << 1) ^ ((remainderBits >>> 11) * 0x1f25);
  const bits = (version << 12) | remainderBits;
  for (let i = 0; i < 18; i++) {
    const dark = bit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = dark;
    modules[a][b] = dark;
  }
}

/** The four penalty rules of the standard: runs, 2×2 blocks, finder-like patterns, imbalance of dark and light. */
function penalty(modules: boolean[][], size: number): number {
  let result = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        run++;
        if (run === 5) result += 3;
        else if (run > 5) result++;
      } else run = 1;
    }
    // Finder-like 1:1:3:1:1 patterns with four light modules on a side.
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= size; i++) {
      if (pattern.every((value, k) => get(i + k) === value)) {
        const before = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
        const after = i + 7 + 4 <= size && [0, 1, 2, 3].every((k) => !get(i + 7 + k));
        if (before || after) result += 40;
      }
    }
  };
  for (let y = 0; y < size; y++) line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) line((y) => modules[y][x]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) result += 3;
  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark++;
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

/** Draw the symbol on a canvas context: dark modules in `ink`, a `quiet` margin of light modules around it. */
export function drawQr(ctx: CanvasRenderingContext2D, symbol: QrSymbol, x: number, y: number, side: number, ink: string, paper: string, quiet = 2) {
  const cells = symbol.size + quiet * 2;
  const unit = side / cells;
  ctx.fillStyle = paper;
  ctx.fillRect(x, y, side, side);
  ctx.fillStyle = ink;
  for (let row = 0; row < symbol.size; row++) {
    for (let column = 0; column < symbol.size; column++) {
      if (symbol.modules[row][column]) ctx.fillRect(x + (column + quiet) * unit, y + (row + quiet) * unit, Math.ceil(unit), Math.ceil(unit));
    }
  }
}
