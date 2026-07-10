// vrf-draws.ts — the FIXED public derivation from on-chain VRF randomness to uniform draws.
// [u8;32] -> up to 4 draws in [0,1): consecutive 8-byte chunks read as big-endian u64, then
// reduced to a double by its top 53 bits / 2^53. This mapping + the pure crate math (crate.ts)
// is what makes a pull provable by recomputation: anyone can take the on-chain bytes and
// re-derive the exact car/scrap/level outcome.
//
// Top-53-bits (not the naive u64/2^64): a double has only 53 mantissa bits, so
// Number(0xFFFF_FFFF_FFFF_FFFFn) rounds UP to 2^64 and u64/2^64 would yield exactly 1.0 —
// breaking the half-open [0,1) contract the crate math relies on. Shifting off the low 11 bits
// first keeps every draw strictly < 1 while landing 0x8000…→0.5 and 0x4000…→0.25 exactly.
export function bytesToDraws(bytes: Uint8Array, n: number): number[] {
  if (n * 8 > bytes.length) throw new Error(`need ${n * 8} bytes, have ${bytes.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number(dv.getBigUint64(i * 8, false) >> 11n) / 2 ** 53);
  return out;
}
