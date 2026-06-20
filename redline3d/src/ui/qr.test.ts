import { describe, it, expect } from "vitest";
import { qrMatrix, qrSvg, _qrTest } from "./qr";

// Vectors below are the published "HELLO WORLD" worked example
// (thonky.com/qr-code-tutorial) — they pin the numeric core exactly.
describe("qr numeric core (known-answer vectors)", () => {
  it("alphanumeric data codewords — HELLO WORLD, v1-Q", () => {
    expect(_qrTest.alnumCodewords("HELLO WORLD", 1, "Q")).toEqual(
      [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236],
    );
  });

  it("reed–solomon ecc — v1-M block (10 ec codewords)", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(_qrTest.rsEcc(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("byte-mode header packs mode + length correctly", () => {
    // 'A' = 0x41. byte mode = 0100, count(8) = 00000001, data = 01000001
    // → 01000000 00010100 0001(pad)… first two codewords are 0x40, 0x14.
    const cw = _qrTest.byteCodewords([0x41], 1, "M");
    expect(cw[0]).toBe(0x40);
    expect(cw[1]).toBe(0x14);
    expect(cw.length).toBe(16); // v1-M data capacity
  });

  it("rs generator polynomial has the requested degree", () => {
    expect(_qrTest.rsGenerator(10)).toHaveLength(10);
  });
});

describe("qr matrix", () => {
  it("sizes the symbol as 4·version + 17 and fits a Solana-length address", () => {
    const m = qrMatrix("So11111111111111111111111111111111111111112"); // 43 chars
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.length).toBe(m[0].length); // square
    expect((m.length - 17) % 4).toBe(0); // valid version size
  });

  it("places the three finder patterns (dark 3×3 centres)", () => {
    const m = qrMatrix("hello");
    const n = m.length;
    expect(m[3][3]).toBe(true); // top-left finder centre
    expect(m[3][n - 4]).toBe(true); // top-right finder centre
    expect(m[n - 4][3]).toBe(true); // bottom-left finder centre
  });

  it("draws an alternating timing pattern on row/col 6", () => {
    const m = qrMatrix("hello");
    const n = m.length;
    for (let i = 8; i < n - 8; i++) expect(m[6][i]).toBe(i % 2 === 0);
  });

  it("is deterministic for the same input", () => {
    expect(qrMatrix("redline")).toEqual(qrMatrix("redline"));
  });
});

describe("qrSvg", () => {
  it("renders an svg with a quiet-zone margin", () => {
    const svg = qrSvg(qrMatrix("hi"), { margin: 4 });
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain('shape-rendering="crispEdges"');
  });
});
