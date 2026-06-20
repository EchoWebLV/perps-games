/**
 * Minimal, dependency-free QR Code encoder (ISO/IEC 18004).
 *
 * Byte + alphanumeric mode, versions 1–10 at EC level M — comfortably enough
 * for any wallet address. Vendored (rather than an npm dep) so the offline APK
 * pulls nothing extra and stays commercial-safe. The numeric core (bit packing,
 * Reed–Solomon, codeword assembly) is pinned by known-answer vectors in qr.test.ts.
 */

export type Ecl = "L" | "M" | "Q" | "H";

// ECL → the 2-bit field baked into the format information.
const ECL_BITS: Record<Ecl, number> = { M: 0, L: 1, H: 2, Q: 3 };

// Per (ecl, version) block structure: [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data].
// Level M is populated for v1–10 (what the app uses); v1 of the other levels is
// included so the test suite can pin the pipeline against published vectors.
type Blk = [number, number, number, number, number];
const ECC: Record<Ecl, Record<number, Blk | undefined>> = {
  M: {
    1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0], 4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0],
    6: [16, 4, 27, 0, 0], 7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37], 10: [26, 4, 43, 1, 44],
  },
  L: { 1: [7, 1, 19, 0, 0] },
  Q: { 1: [13, 1, 13, 0, 0] },
  H: { 1: [17, 1, 9, 0, 0] },
};

// Alignment-pattern centre coordinates per version (v1 has none).
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

// ── GF(256) Reed–Solomon (primitive polynomial 0x11D) ──────────────────────
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial of the given degree (coefficients excluding the leading 1). */
function rsGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

/** Reed–Solomon error-correction codewords for a data block. */
function rsEcc(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const res = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < degree; i++) res[i] ^= gfMul(gen[i], factor);
  }
  return res;
}

// ── bit buffer + data codewords ────────────────────────────────────────────
class BitBuf {
  bits: number[] = [];
  push(val: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  }
}

const byteCountBits = (v: number) => (v <= 9 ? 8 : 16);
const alnumCountBits = (v: number) => (v <= 9 ? 9 : v <= 26 ? 11 : 13);

function writeByte(bb: BitBuf, bytes: number[], version: number): void {
  bb.push(0b0100, 4);
  bb.push(bytes.length, byteCountBits(version));
  for (const b of bytes) bb.push(b, 8);
}

function writeAlnum(bb: BitBuf, text: string, version: number): void {
  bb.push(0b0010, 4);
  bb.push(text.length, alnumCountBits(version));
  for (let i = 0; i + 1 < text.length; i += 2) {
    bb.push(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
  }
  if (text.length % 2) bb.push(ALNUM.indexOf(text[text.length - 1]), 6);
}

function ecc(version: number, ecl: Ecl): Blk {
  const row = ECC[ecl][version];
  if (!row) throw new Error(`QR: unsupported version/level ${version}-${ecl}`);
  return row;
}

/** Add terminator + bit/byte padding, then split into the final data codewords. */
function finishCodewords(bb: BitBuf, version: number, ecl: Ecl): number[] {
  const [, g1b, g1d, g2b, g2d] = ecc(version, ecl);
  const cap = (g1b * g1d + g2b * g2d) * 8;
  for (let i = 0; i < 4 && bb.bits.length < cap; i++) bb.bits.push(0); // terminator
  while (bb.bits.length % 8 !== 0) bb.bits.push(0); // pad to a byte boundary
  for (let i = 0; bb.bits.length < cap; i++) {
    const pad = i % 2 === 0 ? 0xec : 0x11;
    for (let k = 7; k >= 0; k--) bb.bits.push((pad >>> k) & 1);
  }
  const cw: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bb.bits[i + k];
    cw.push(b);
  }
  return cw;
}

/** Split data codewords into blocks, append RS ECC, and interleave per spec. */
function interleave(dataCw: number[], version: number, ecl: Ecl): number[] {
  const [ecLen, g1b, g1d, g2b, g2d] = ecc(version, ecl);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let pos = 0;
  const take = (count: number, len: number) => {
    for (let i = 0; i < count; i++) {
      const block = dataCw.slice(pos, pos + len);
      pos += len;
      dataBlocks.push(block);
      ecBlocks.push(rsEcc(block, ecLen));
    }
  };
  take(g1b, g1d);
  take(g2b, g2d);

  const out: number[] = [];
  const maxData = Math.max(g1d, g2d);
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecBlocks) out.push(e[i]);
  return out;
}

// ── module matrix ──────────────────────────────────────────────────────────
const getBit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
  }
}

class Matrix {
  size: number;
  mod: boolean[][]; // true = dark
  fn: boolean[][]; // true = function module (not data)
  constructor(public version: number) {
    this.size = version * 4 + 17;
    this.mod = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  private set(x: number, y: number, dark: boolean): void {
    this.mod[y][x] = dark;
    this.fn[y][x] = true;
  }
  drawFunction(): void {
    const n = this.size;
    // timing patterns
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    // finder patterns (+ separators) at three corners
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    // alignment patterns
    const pos = ALIGN[this.version];
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.alignment(pos[i], pos[j]);
      }
    }
  }
  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  private alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
}

// The heavy steps live as standalone functions operating on a Matrix so each
// one stays focused (format/version info, data placement, masking, scoring).
function drawFormat(m: Matrix, ecl: Ecl, mask: number): void {
  const data = (ECL_BITS[ecl] << 3) | mask; // 5 bits
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412; // 15-bit masked format info
  const n = m.size;
  const put = (x: number, y: number, b: boolean) => { m.mod[y][x] = b; m.fn[y][x] = true; };
  // copy 1 — around the top-left finder
  for (let i = 0; i <= 5; i++) put(8, i, getBit(bits, i));
  put(8, 7, getBit(bits, 6));
  put(8, 8, getBit(bits, 7));
  put(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, getBit(bits, i));
  // copy 2 — split across the other two finders
  for (let i = 0; i < 8; i++) put(n - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) put(8, n - 15 + i, getBit(bits, i));
  put(8, n - 8, true); // the module that is always dark
}

function drawVersion(m: Matrix): void {
  if (m.version < 7) return;
  let rem = m.version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (m.version << 12) | rem; // 18-bit version info
  const n = m.size;
  for (let i = 0; i < 18; i++) {
    const b = getBit(bits, i);
    const a = n - 11 + (i % 3), c = Math.floor(i / 3);
    m.mod[a][c] = b; m.fn[a][c] = true;
    m.mod[c][a] = b; m.fn[c][a] = true;
  }
}

function placeData(m: Matrix, codewords: number[]): void {
  const n = m.size;
  let i = 0; // bit cursor
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!m.fn[y][x] && i < codewords.length * 8) {
          m.mod[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++)
    for (let x = 0; x < m.size; x++)
      if (!m.fn[y][x] && maskBit(mask, x, y)) m.mod[y][x] = !m.mod[y][x];
}

function penalty(m: Matrix): number {
  const n = m.size, g = m.mod;
  let p = 0;
  // rule 1 — runs of 5+ same-colour modules in any row or column
  const runs = (at: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let color = at(i, 0), len = 1;
      for (let j = 1; j < n; j++) {
        if (at(i, j) === color) { len++; if (len === 5) p += 3; else if (len > 5) p += 1; }
        else { color = at(i, j); len = 1; }
      }
    }
  };
  runs((y, x) => g[y][x]);
  runs((x, y) => g[y][x]);
  // rule 2 — 2×2 blocks of one colour
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const c = g[y][x];
      if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) p += 3;
    }
  // rule 3 — finder-like 1:1:3:1:1 patterns with a 4-module light gap
  const seqs = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      for (const s of seqs) {
        if (x + s.length <= n && s.every((v, k) => g[y][x + k] === v)) p += 40;
        if (y + s.length <= n && s.every((v, k) => g[y + k][x] === v)) p += 40;
      }
  // rule 4 — overall dark/light balance
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (g[y][x]) dark++;
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

// ── public API ─────────────────────────────────────────────────────────────
const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

function pickVersion(bytes: number[], ecl: Ecl): number {
  for (let v = 1; v <= 10; v++) {
    if (!ECC[ecl][v]) continue;
    const [, g1b, g1d, g2b, g2d] = ecc(v, ecl);
    const cap = (g1b * g1d + g2b * g2d) * 8;
    if (4 + byteCountBits(v) + bytes.length * 8 <= cap) return v;
  }
  throw new Error("QR: input too long for versions 1–10");
}

/** Encode `text` (byte mode) into a module matrix (true = dark, no quiet zone). */
export function qrMatrix(text: string, ecl: Ecl = "M"): boolean[][] {
  const bytes = utf8(text);
  const version = pickVersion(bytes, ecl);
  const bb = new BitBuf();
  writeByte(bb, bytes, version);
  const codewords = interleave(finishCodewords(bb, version, ecl), version, ecl);

  const m = new Matrix(version);
  m.drawFunction();
  drawFormat(m, ecl, 0); // reserve
  drawVersion(m);
  placeData(m, codewords);

  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, mask);
    drawFormat(m, ecl, mask);
    const score = penalty(m);
    if (score < bestScore) { bestScore = score; best = mask; }
    applyMask(m, mask); // undo
  }
  applyMask(m, best);
  drawFormat(m, ecl, best);
  return m.mod;
}

/** Render a module matrix to a crisp, themeable SVG string. */
export function qrSvg(
  matrix: boolean[][],
  opts: { dark?: string; light?: string; margin?: number } = {},
): string {
  const n = matrix.length;
  const margin = opts.margin ?? 4;
  const dim = n + margin * 2;
  const dark = opts.dark ?? "#0a0820";
  const light = opts.light ?? "#ffffff";
  let path = "";
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (matrix[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
  return (
    `<svg viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg" ` +
    `shape-rendering="crispEdges" style="width:100%;height:100%;display:block">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

// Internals exposed purely for the known-answer tests.
export const _qrTest = {
  rsEcc,
  rsGenerator,
  alnumCodewords: (text: string, version: number, ecl: Ecl) => {
    const bb = new BitBuf();
    writeAlnum(bb, text, version);
    return finishCodewords(bb, version, ecl);
  },
  byteCodewords: (bytes: number[], version: number, ecl: Ecl) => {
    const bb = new BitBuf();
    writeByte(bb, bytes, version);
    return finishCodewords(bb, version, ecl);
  },
};
