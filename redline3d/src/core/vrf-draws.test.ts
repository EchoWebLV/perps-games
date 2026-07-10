import { describe, it, expect } from "vitest";
import { bytesToDraws } from "./vrf-draws";

describe("bytesToDraws", () => {
  it("maps 8-byte BE chunks to uniform [0,1) draws", () => {
    const bytes = new Uint8Array(32);
    // chunk 0 = 0x0000000000000000 -> 0
    // chunk 1 = 0x8000000000000000 -> 0.5
    bytes[8] = 0x80;
    // chunk 2 = 0xFFFFFFFFFFFFFFFF -> just under 1
    for (let i = 16; i < 24; i++) bytes[i] = 0xff;
    // chunk 3 = 0x4000000000000000 -> 0.25
    bytes[24] = 0x40;
    const d = bytesToDraws(bytes, 4);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(0.5);
    expect(d[2]).toBeLessThan(1);
    expect(d[2]).toBeGreaterThan(0.9999999999);
    expect(d[3]).toBe(0.25);
  });
  it("throws if more draws are requested than the bytes hold", () => {
    expect(() => bytesToDraws(new Uint8Array(32), 5)).toThrow();
  });
});
