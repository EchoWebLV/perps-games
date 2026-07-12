import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import packageText from "../../package.json?raw";

const rendererHtmlFiles = import.meta.glob("../../building-renderer.html", { eager: true, import: "default", query: "?raw" });
const rendererSourceFiles = import.meta.glob("./building-renderer.ts", { eager: true, import: "default", query: "?raw" });
const captureSourceFiles = import.meta.glob("../../scripts/render-landing-buildings.mjs", { eager: true, import: "default", query: "?raw" });
const loadNodeUrl = () => {
  const nodeUrlModule = "node:url";
  return import(/* @vite-ignore */ nodeUrlModule) as Promise<typeof import("node:url")>;
};
const fileUrlPath = async (url: URL) => (await loadNodeUrl()).fileURLToPath(url);
const filePathUrl = async (path: string) => (await loadNodeUrl()).pathToFileURL(path);
const buildingAssetPath = (building: string) => fileUrlPath(new URL(`../../public/assets/landing/building-${building}.webp`, import.meta.url));

const readU16 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const readU24 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
const readU32 = (bytes: Uint8Array, offset: number) => bytes[offset] + (bytes[offset + 1] * 0x100) + (bytes[offset + 2] * 0x10000) + (bytes[offset + 3] * 0x1000000);
const readFourCC = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

type WebPChunk = {
  type: string;
  payloadOffset: number;
  payloadSize: number;
};

function assertWebP(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const runDwebp = async (args: string[]) => {
  const childProcessModule = "node:child_process";
  const { execFile } = await import(/* @vite-ignore */ childProcessModule) as typeof import("node:child_process");
  return new Promise<number>((resolve, reject) => {
    execFile("dwebp", args, (error) => {
      if (error?.code === "ENOENT") {
        reject(new Error("dwebp is required on PATH to verify committed WebP decodability"));
        return;
      }
      resolve(typeof error?.code === "number" ? error.code : error ? 1 : 0);
    });
  });
};

const validateBuildingWebP = (bytes: Uint8Array) => {
  assertWebP(bytes.length >= 12, "WebP container is shorter than its RIFF header");
  assertWebP(readFourCC(bytes, 0) === "RIFF", "missing RIFF signature");
  assertWebP(readFourCC(bytes, 8) === "WEBP", "missing WEBP signature");

  const declaredSize = readU32(bytes, 4);
  assertWebP(declaredSize + 8 === bytes.length, "RIFF size does not match file length");

  const chunks: WebPChunk[] = [];
  let cursor = 12;

  while (cursor < bytes.length) {
    const payloadOffset = cursor + 8;
    assertWebP(payloadOffset <= bytes.length, "chunk header exceeds file length");

    const chunkType = readFourCC(bytes, cursor);
    const payloadSize = readU32(bytes, cursor + 4);
    const payloadEnd = payloadOffset + payloadSize;
    assertWebP(payloadEnd <= bytes.length, `${chunkType} payload exceeds file length`);

    const paddedEnd = payloadEnd + (payloadSize % 2);
    assertWebP(paddedEnd <= bytes.length, `${chunkType} padded boundary exceeds file length`);
    if (payloadSize % 2 === 1) assertWebP(bytes[payloadEnd] === 0, `${chunkType} pad byte must be zero`);

    chunks.push({ type: chunkType, payloadOffset, payloadSize });
    cursor = paddedEnd;
  }

  assertWebP(cursor === bytes.length, "RIFF chunks do not end at file length");

  const vp8xChunk = chunks.find((chunk) => chunk.type === "VP8X");
  assertWebP(vp8xChunk !== undefined, "missing VP8X chunk");
  assertWebP(vp8xChunk.payloadSize >= 10, "VP8X payload is too short");
  assertWebP((bytes[vp8xChunk.payloadOffset] & 0x10) === 0x10, "missing alpha flag");
  const canvasWidth = readU24(bytes, vp8xChunk.payloadOffset + 4) + 1;
  const canvasHeight = readU24(bytes, vp8xChunk.payloadOffset + 7) + 1;
  assertWebP(canvasWidth === 1024, "unexpected canvas width");
  assertWebP(canvasHeight === 720, "unexpected canvas height");

  const alphChunk = chunks.find((chunk) => chunk.type === "ALPH");
  assertWebP(alphChunk !== undefined, "missing ALPH chunk");
  assertWebP(alphChunk.payloadSize >= 2, "ALPH payload is too short");
  const alphControl = bytes[alphChunk.payloadOffset];
  assertWebP((alphControl & 0xc0) === 0, "ALPH control reserved bits must be zero");
  const alphCompression = alphControl & 0x03;
  const alphPreprocessing = (alphControl >> 4) & 0x03;
  assertWebP(alphCompression <= 1, "ALPH compression method is unsupported");
  assertWebP(alphPreprocessing <= 1, "ALPH preprocessing method is unsupported");
  if (alphCompression === 0) assertWebP(alphChunk.payloadSize === 1 + (canvasWidth * canvasHeight), "raw ALPH payload size does not match canvas");

  const vp8Chunk = chunks.find((chunk) => chunk.type === "VP8 ");
  assertWebP(vp8Chunk !== undefined, "missing VP8 image payload");
  assertWebP(vp8Chunk.payloadSize >= 10, "VP8 payload is too short");
  const frameTag = readU24(bytes, vp8Chunk.payloadOffset);
  assertWebP((frameTag & 0x01) === 0, "VP8 payload is not a key frame");
  assertWebP(bytes[vp8Chunk.payloadOffset + 3] === 0x9d && bytes[vp8Chunk.payloadOffset + 4] === 0x01 && bytes[vp8Chunk.payloadOffset + 5] === 0x2a, "VP8 key-frame start code is invalid");
  assertWebP((readU16(bytes, vp8Chunk.payloadOffset + 6) & 0x3fff) === 1024, "unexpected VP8 frame width");
  assertWebP((readU16(bytes, vp8Chunk.payloadOffset + 8) & 0x3fff) === 720, "unexpected VP8 frame height");
  const firstPartitionLength = frameTag >>> 5;
  assertWebP(firstPartitionLength > 0, "VP8 first partition is empty");
  assertWebP(firstPartitionLength <= vp8Chunk.payloadSize - 10, "VP8 first partition exceeds payload");
};

type WebPChunkFixture = {
  type: string;
  payload: Uint8Array;
  padByte?: number;
};

const writeFourCC = (bytes: Uint8Array, offset: number, value: string) => {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = value.charCodeAt(index);
};

const makeWebPFixture = (chunks: WebPChunkFixture[]) => {
  const byteLength = 12 + chunks.reduce((length, chunk) => length + 8 + chunk.payload.length + (chunk.payload.length % 2), 0);
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  writeFourCC(bytes, 0, "RIFF");
  view.setUint32(4, byteLength - 8, true);
  writeFourCC(bytes, 8, "WEBP");

  let cursor = 12;
  for (const chunk of chunks) {
    writeFourCC(bytes, cursor, chunk.type);
    view.setUint32(cursor + 4, chunk.payload.length, true);
    bytes.set(chunk.payload, cursor + 8);
    cursor += 8 + chunk.payload.length;
    if (chunk.payload.length % 2 === 1) {
      bytes[cursor] = chunk.padByte ?? 0;
      cursor += 1;
    }
  }
  return bytes;
};

const validVp8xPayload = Uint8Array.of(0x10, 0, 0, 0, 0xff, 0x03, 0, 0xcf, 0x02, 0);
const validAlphPayload = Uint8Array.of(1, 0);
const validVp8Payload = Uint8Array.of(0x30, 0, 0, 0x9d, 0x01, 0x2a, 0, 0x04, 0xd0, 0x02, 0);

const makeBuildingWebPFixture = (alphPayload = validAlphPayload, vp8Payload = validVp8Payload) => makeWebPFixture([
  { type: "VP8X", payload: validVp8xPayload },
  { type: "ALPH", payload: alphPayload },
  { type: "VP8 ", payload: vp8Payload },
]);

const findChunk = (bytes: Uint8Array, type: string) => {
  let cursor = 12;
  while (cursor < bytes.length) {
    const payloadSize = readU32(bytes, cursor + 4);
    if (readFourCC(bytes, cursor) === type) return { payloadOffset: cursor + 8, payloadSize };
    cursor += 8 + payloadSize + (payloadSize % 2);
  }
  throw new Error(`missing ${type} fixture chunk`);
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
      const bytes = await readFile(await buildingAssetPath(building));
      expect(() => validateBuildingWebP(bytes)).not.toThrow();
    }
  });

  it("decodes every committed building WebP with dwebp", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perps-rider-dwebp-"));
    try {
      for (const building of ["track", "garage", "upgrades", "crates"]) {
        const input = await buildingAssetPath(building);
        const output = join(directory, `${building}.pam`);
        expect(await runDwebp([input, "-pam", "-o", output])).toBe(0);
        expect((await readFile(output)).length).toBeGreaterThan(0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("decodes a WebP from a file URL whose path contains spaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "perps rider dwebp "));
    try {
      const input = join(directory, "building track.webp");
      const output = join(directory, "building track.pam");
      await writeFile(input, await readFile(await buildingAssetPath("track")));
      const inputUrl = await filePathUrl(input);
      const decoderInput = await fileUrlPath(inputUrl);

      expect(await runDwebp([decoderInput, "-pam", "-o", output])).toBe(0);
      expect(decoderInput).toBe(input);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a 30-byte header-only WebP using the declared RIFF size", async () => {
    const bytes = await readFile(await buildingAssetPath("track"));

    expect(() => validateBuildingWebP(bytes.subarray(0, 30))).toThrow("RIFF size does not match file length");
  });

  it("rejects a 30-byte WebP with a forged RIFF size and no image chunks", async () => {
    const bytes = await readFile(await buildingAssetPath("track"));
    const truncatedBytes = Uint8Array.from(bytes.subarray(0, 30));
    new DataView(truncatedBytes.buffer).setUint32(4, truncatedBytes.length - 8, true);

    expect(() => validateBuildingWebP(truncatedBytes)).toThrow("missing ALPH chunk");
  });

  it("rejects a zero-byte ALPH payload", () => {
    const bytes = makeWebPFixture([
      { type: "VP8X", payload: validVp8xPayload },
      { type: "ALPH", payload: new Uint8Array() },
      { type: "VP8 ", payload: validVp8Payload },
    ]);

    expect(() => validateBuildingWebP(bytes)).toThrow("ALPH payload is too short");
  });

  it("rejects a zero-byte VP8 payload", () => {
    const bytes = makeWebPFixture([
      { type: "VP8X", payload: validVp8xPayload },
      { type: "ALPH", payload: validAlphPayload },
      { type: "VP8 ", payload: new Uint8Array() },
    ]);

    expect(() => validateBuildingWebP(bytes)).toThrow("VP8 payload is too short");
  });

  it("rejects a nonzero odd-chunk pad byte", () => {
    const bytes = makeWebPFixture([
      { type: "VP8X", payload: validVp8xPayload },
      { type: "JUNK", payload: Uint8Array.of(0), padByte: 1 },
      { type: "ALPH", payload: validAlphPayload },
      { type: "VP8 ", payload: validVp8Payload },
    ]);

    expect(() => validateBuildingWebP(bytes)).toThrow("JUNK pad byte must be zero");
  });

  it("rejects reserved ALPH control bit 0x40", () => {
    const alphPayload = Uint8Array.from(validAlphPayload);
    alphPayload[0] = 0x40 | 1;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(alphPayload))).toThrow("ALPH control reserved bits must be zero");
  });

  it("rejects reserved ALPH control bit 0x80", () => {
    const alphPayload = Uint8Array.from(validAlphPayload);
    alphPayload[0] = 0x80 | 1;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(alphPayload))).toThrow("ALPH control reserved bits must be zero");
  });

  it.each([2, 3])("rejects unsupported ALPH compression method %i", (compression) => {
    const alphPayload = Uint8Array.from(validAlphPayload);
    alphPayload[0] = compression;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(alphPayload))).toThrow("ALPH compression method is unsupported");
  });

  it.each([2, 3])("rejects ALPH preprocessing method %i", (preprocessing) => {
    const alphPayload = Uint8Array.from(validAlphPayload);
    alphPayload[0] = (preprocessing << 4) | 1;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(alphPayload))).toThrow("ALPH preprocessing method is unsupported");
  });

  it("rejects a raw ALPH plane with the wrong length", () => {
    expect(() => validateBuildingWebP(makeBuildingWebPFixture(Uint8Array.of(0, 0)))).toThrow("raw ALPH payload size does not match canvas");
  });

  it("rejects a VP8 interframe", () => {
    const vp8Payload = Uint8Array.from(validVp8Payload);
    vp8Payload[0] |= 0x01;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(validAlphPayload, vp8Payload))).toThrow("VP8 payload is not a key frame");
  });

  it.each([[0, 3], [1, 4], [2, 5]])("rejects bad VP8 key-frame start-code byte %i", (_startCodeIndex, payloadOffset) => {
    const vp8Payload = Uint8Array.from(validVp8Payload);
    vp8Payload[payloadOffset] = 0;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(validAlphPayload, vp8Payload))).toThrow("VP8 key-frame start code is invalid");
  });

  it("rejects wrong VP8 frame dimensions", () => {
    const vp8Payload = Uint8Array.from(validVp8Payload);
    vp8Payload[6] = 1;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(validAlphPayload, vp8Payload))).toThrow("unexpected VP8 frame width");
  });

  it("rejects a wrong VP8 frame height", () => {
    const vp8Payload = Uint8Array.from(validVp8Payload);
    vp8Payload[8] = 0xd1;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(validAlphPayload, vp8Payload))).toThrow("unexpected VP8 frame height");
  });

  it("rejects an empty VP8 first partition", () => {
    const vp8Payload = Uint8Array.from(validVp8Payload);
    vp8Payload[0] = 0x10;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(validAlphPayload, vp8Payload))).toThrow("VP8 first partition is empty");
  });

  it("rejects an oversized VP8 first partition", () => {
    const vp8Payload = Uint8Array.from(validVp8Payload);
    vp8Payload[0] = 0x50;

    expect(() => validateBuildingWebP(makeBuildingWebPFixture(validAlphPayload, vp8Payload))).toThrow("VP8 first partition exceeds payload");
  });

  it("has dwebp reject a structurally valid WebP with a zeroed compressed ALPH body", async () => {
    const bytes = await readFile(await buildingAssetPath("track"));
    const corruptedBytes = Uint8Array.from(bytes);
    const alphChunk = findChunk(corruptedBytes, "ALPH");
    corruptedBytes.fill(0, alphChunk.payloadOffset + 1, alphChunk.payloadOffset + alphChunk.payloadSize);
    expect(() => validateBuildingWebP(corruptedBytes)).not.toThrow();

    const directory = await mkdtemp(join(tmpdir(), "perps-rider-dwebp-corrupt-"));
    try {
      const input = join(directory, "corrupt.webp");
      const output = join(directory, "corrupt.pam");
      await writeFile(input, corruptedBytes);
      expect(await runDwebp([input, "-pam", "-o", output])).not.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
