/** Byte-mode QR, error correction L, versions 1–6. No dependency. */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

type Version = {
  version: number;
  size: number;
  dataCodewords: number;
  ecPerBlock: number;
  blocks: number;
  align: number[];
};

const VERSIONS: Version[] = [
  { version: 1, size: 21, dataCodewords: 19, ecPerBlock: 7, blocks: 1, align: [] },
  { version: 2, size: 25, dataCodewords: 34, ecPerBlock: 10, blocks: 1, align: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, ecPerBlock: 15, blocks: 1, align: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, ecPerBlock: 20, blocks: 1, align: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, ecPerBlock: 26, blocks: 1, align: [6, 30] },
  { version: 6, size: 41, dataCodewords: 136, ecPerBlock: 18, blocks: 2, align: [6, 34] },
];

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = mul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = mul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const value of data) {
    const factor = (value ^ result[0]) & 0xff;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= mul(divisor[i], factor);
  }
  return result;
}

function appendBits(bits: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function encodeBytes(text: string, dataCodewords: number): number[] {
  const bytes = Array.from(Buffer.from(text, "utf8"));
  const bits: number[] = [];
  const capacity = dataCodewords * 8;
  appendBits(bits, 0x4, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  const terminator = Math.min(4, Math.max(0, capacity - bits.length));
  appendBits(bits, 0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);
  const pad = [0xec, 0x11];
  let padIndex = 0;
  while (bits.length + 8 <= capacity) {
    appendBits(bits, pad[padIndex % 2], 8);
    padIndex++;
  }
  if (bits.length !== capacity) throw new Error("QR payload does not fit");
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    out.push(value);
  }
  return out;
}

function pickVersion(byteLength: number): Version {
  const needed = Math.ceil((4 + 8 + byteLength * 8) / 8);
  const found = VERSIONS.find((version) => needed <= version.dataCodewords);
  if (!found) throw new Error("QR payload is too long");
  return found;
}

function interleave(version: Version, data: number[]): number[] {
  const perBlock = version.dataCodewords / version.blocks;
  const divisor = rsDivisor(version.ecPerBlock);
  const blocks: number[][] = [];
  const ecs: number[][] = [];
  for (let i = 0; i < version.blocks; i++) {
    const block = data.slice(i * perBlock, (i + 1) * perBlock);
    blocks.push(block);
    ecs.push(rsRemainder(block, divisor));
  }
  const out: number[] = [];
  for (let i = 0; i < perBlock; i++) {
    for (const block of blocks) out.push(block[i]);
  }
  for (let i = 0; i < version.ecPerBlock; i++) {
    for (const ec of ecs) out.push(ec[i]);
  }
  return out;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function drawFinder(modules: boolean[][], fun: boolean[][], x: number, y: number) {
  const size = modules.length;
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      const outside = dx < 0 || dy < 0 || dx > 6 || dy > 6;
      const edge = dx === 0 || dy === 0 || dx === 6 || dy === 6;
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      modules[yy][xx] = !outside && (edge || core);
      fun[yy][xx] = true;
    }
  }
}

function drawAlignment(modules: boolean[][], fun: boolean[][], x: number, y: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      modules[y + dy][x + dx] = dist !== 1;
      fun[y + dy][x + dx] = true;
    }
  }
}

function functionModules(version: Version): { modules: boolean[][]; fun: boolean[][] } {
  const size = version.size;
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const fun = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  drawFinder(modules, fun, 0, 0);
  drawFinder(modules, fun, size - 7, 0);
  drawFinder(modules, fun, 0, size - 7);
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    modules[6][i] = dark;
    fun[6][i] = true;
    modules[i][6] = dark;
    fun[i][6] = true;
  }
  const corners = (x: number, y: number) =>
    (x < 9 && y < 9) || (x < 9 && y > size - 10) || (x > size - 10 && y < 9);
  for (const x of version.align) {
    for (const y of version.align) {
      if (corners(x, y)) continue;
      drawAlignment(modules, fun, x, y);
    }
  }
  modules[size - 8][8] = true;
  fun[size - 8][8] = true;
  for (let i = 0; i < 9; i++) {
    fun[i][8] = true;
    fun[8][i] = true;
    fun[(size - i) % size][8] = true;
    fun[8][(size - i) % size] = true;
  }
  return { modules, fun };
}

/** Level L, masks 0–7. ISO/IEC 18004 Table C.1. */
const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];

function drawFormat(modules: boolean[][], fun: boolean[][], mask: number) {
  const size = modules.length;
  const format = FORMAT_L[mask];
  let voffset = 0;
  let hoffset = 0;
  for (let i = 0; i < 8; i++) {
    const low = ((format >>> i) & 1) === 1;
    const high = ((format >>> (14 - i)) & 1) === 1;
    if (i === 6) {
      voffset += 1;
      hoffset = 1;
    }
    const set = (x: number, y: number, dark: boolean) => {
      modules[y][x] = dark;
      fun[y][x] = true;
    };
    set(8, i + voffset, low);
    set(i + hoffset, 8, high);
    set(size - 1 - i, 8, low);
    set(8, size - 1 - i, high);
  }
  modules[size - 8][8] = true;
  fun[size - 8][8] = true;
}

function placeData(modules: boolean[][], fun: boolean[][], codewords: number[], mask: number) {
  const size = modules.length;
  const bits: number[] = [];
  for (const word of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((word >>> i) & 1);
  }
  let index = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    const right = col <= 6 ? col - 1 : col;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let z = 0; z < 2; z++) {
        const x = right - z;
        const upwards = ((right & 2) === 0) !== (x < 6);
        const y = upwards ? size - 1 - vertical : vertical;
        if (fun[y][x]) continue;
        const bit = index < bits.length ? bits[index] : 0;
        index++;
        const dark = bit === 1;
        modules[y][x] = maskBit(mask, x, y) ? !dark : dark;
      }
    }
  }
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const run = (read: (i: number) => boolean) => {
    let count = 1;
    let color = read(0);
    for (let i = 1; i < size; i++) {
      if (read(i) === color) {
        count++;
      } else {
        if (count >= 5) score += count - 2;
        color = read(i);
        count = 1;
      }
    }
    if (count >= 5) score += count - 2;
  };
  for (let y = 0; y < size; y++) run((x) => modules[y][x]);
  for (let x = 0; x < size; x++) run((y) => modules[y][x]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y][x];
      if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) score += 3;
    }
  }
  const finder = (line: boolean[], i: number) => {
    const dark = (offset: number) => line[i + offset];
    const a = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const b = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const match = (pattern: number[]) => pattern.every((bit, offset) => dark(offset) === (bit === 1));
    return match(a) || match(b);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) if (finder(modules[y], x)) score += 40;
  }
  for (let x = 0; x < size; x++) {
    const column = modules.map((row) => row[x]);
    for (let y = 0; y <= size - 11; y++) if (finder(column, y)) score += 40;
  }
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

export function qrMatrix(text: string): boolean[][] {
  const version = pickVersion(Buffer.byteLength(text));
  const data = encodeBytes(text, version.dataCodewords);
  const codewords = interleave(version, data);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const base = functionModules(version);
    placeData(base.modules, base.fun, codewords, mask);
    drawFormat(base.modules, base.fun, mask);
    const score = penalty(base.modules);
    if (score < bestScore) {
      bestScore = score;
      best = base.modules;
    }
  }
  return best!;
}

export function qrSvg(text: string): string {
  const modules = qrMatrix(text);
  const quiet = 4;
  const span = modules.length + quiet * 2;
  let path = "";
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) {
      if (modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" aria-label="Setup link"><rect width="${span}" height="${span}" fill="#e7e7e9"/><path fill="#1d1d1f" d="${path}"/></svg>`;
}
