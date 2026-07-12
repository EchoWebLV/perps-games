import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import packageText from "../../package.json?raw";

const rendererHtmlFiles = import.meta.glob("../../building-renderer.html", { eager: true, import: "default", query: "?raw" });
const rendererSourceFiles = import.meta.glob("./building-renderer.ts", { eager: true, import: "default", query: "?raw" });
const captureSourceFiles = import.meta.glob("../../scripts/render-landing-buildings.mjs", { eager: true, import: "default", query: "?raw" });

const readU24 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
const readU32 = (bytes: Uint8Array, offset: number) => bytes[offset] + (bytes[offset + 1] * 0x100) + (bytes[offset + 2] * 0x10000) + (bytes[offset + 3] * 0x1000000);
const readFourCC = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

function assertWebP(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const validateBuildingWebP = (bytes: Uint8Array) => {
  assertWebP(bytes.length >= 12, "WebP container is shorter than its RIFF header");
  assertWebP(readFourCC(bytes, 0) === "RIFF", "missing RIFF signature");
  assertWebP(readFourCC(bytes, 8) === "WEBP", "missing WEBP signature");

  const declaredSize = readU32(bytes, 4);
  assertWebP(declaredSize + 8 === bytes.length, "RIFF size does not match file length");

  const chunkTypes = new Set<string>();
  let cursor = 12;
  let vp8xPayloadOffset: number | undefined;
  let vp8xPayloadSize = 0;

  while (cursor < bytes.length) {
    const payloadOffset = cursor + 8;
    assertWebP(payloadOffset <= bytes.length, "chunk header exceeds file length");

    const chunkType = readFourCC(bytes, cursor);
    const payloadSize = readU32(bytes, cursor + 4);
    const payloadEnd = payloadOffset + payloadSize;
    assertWebP(payloadEnd <= bytes.length, `${chunkType} payload exceeds file length`);

    const paddedEnd = payloadEnd + (payloadSize % 2);
    assertWebP(paddedEnd <= bytes.length, `${chunkType} padded boundary exceeds file length`);

    chunkTypes.add(chunkType);
    if (chunkType === "VP8X" && vp8xPayloadOffset === undefined) {
      vp8xPayloadOffset = payloadOffset;
      vp8xPayloadSize = payloadSize;
    }
    cursor = paddedEnd;
  }

  assertWebP(cursor === bytes.length, "RIFF chunks do not end at file length");
  assertWebP(vp8xPayloadOffset !== undefined, "missing VP8X chunk");
  assertWebP(vp8xPayloadSize >= 10, "VP8X payload is too short");
  assertWebP(chunkTypes.has("ALPH"), "missing ALPH chunk");
  assertWebP(chunkTypes.has("VP8 ") || chunkTypes.has("VP8L"), "missing VP8 image payload");
  assertWebP((bytes[vp8xPayloadOffset] & 0x10) === 0x10, "missing alpha flag");
  assertWebP(readU24(bytes, vp8xPayloadOffset + 4) + 1 === 1024, "unexpected canvas width");
  assertWebP(readU24(bytes, vp8xPayloadOffset + 7) + 1 === 720, "unexpected canvas height");
};

describe("landing building renderer", () => {
  it("renders the real game buildings through a transparent orthographic scene", () => {
    expect(Object.keys(rendererHtmlFiles)).toHaveLength(1);
    expect(Object.keys(rendererSourceFiles)).toHaveLength(1);
    const rendererHtml = Object.values(rendererHtmlFiles)[0] as string;
    const rendererSource = Object.values(rendererSourceFiles)[0] as string;
    expect(rendererHtml).toContain('/src/landing/building-renderer.ts');
    for (const builder of ["buildTrack", "buildGarage", "buildUpgrades", "buildCrates"]) {
      expect(rendererSource).toContain(builder);
    }
    expect(rendererSource).toContain("OrthographicCamera");
    expect(rendererSource).toContain("alpha: true");
    expect(rendererSource).toContain('dataset.ready = "true"');
  });

  it("captures every building as a committed WebP", () => {
    expect(Object.keys(captureSourceFiles)).toHaveLength(1);
    const captureSource = Object.values(captureSourceFiles)[0] as string;
    for (const building of ["track", "garage", "upgrades", "crates"]) {
      expect(captureSource).toContain(`"${building}"`);
      expect(captureSource).toContain(`building-${building}.webp`);
    }
    expect(captureSource).toContain('type: "webp"');
    expect(captureSource).toContain("omitBackground: true");
    expect(JSON.parse(packageText).scripts["render:landing-buildings"]).toBe("node scripts/render-landing-buildings.mjs");
  });

  it("commits decodable alpha WebPs at the required dimensions", async () => {
    for (const building of ["track", "garage", "upgrades", "crates"]) {
      const bytes = await readFile(new URL(`../../public/assets/landing/building-${building}.webp`, import.meta.url));
      expect(() => validateBuildingWebP(bytes)).not.toThrow();
    }
  });

  it("rejects a 30-byte header-only WebP using the declared RIFF size", async () => {
    const bytes = await readFile(new URL("../../public/assets/landing/building-track.webp", import.meta.url));

    expect(() => validateBuildingWebP(bytes.subarray(0, 30))).toThrow("RIFF size does not match file length");
  });

  it("rejects a 30-byte WebP with a forged RIFF size and no image chunks", async () => {
    const bytes = await readFile(new URL("../../public/assets/landing/building-track.webp", import.meta.url));
    const truncatedBytes = Uint8Array.from(bytes.subarray(0, 30));
    new DataView(truncatedBytes.buffer).setUint32(4, truncatedBytes.length - 8, true);

    expect(() => validateBuildingWebP(truncatedBytes)).toThrow("missing ALPH chunk");
  });
});
