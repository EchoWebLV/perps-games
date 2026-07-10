import { describe, expect, test } from "vitest";

const nodeFs = "node:fs";
const { statSync } = await import(/* @vite-ignore */ nodeFs);

const BASENAMES = ["drive", "lobby", "market-side", "leverage", "cash-out"] as const;
const LIMITS = { webm: 600_000, mp4: 900_000, webp: 200_000 } as const;

function sizeOf(base: string, extension: keyof typeof LIMITS): number {
  const url = new URL(`../../public/tutorial/${base}.${extension}`, import.meta.url);
  return statSync(url).size;
}

describe("how-to media assets", () => {
  test("ships every source and poster within its byte budget", () => {
    for (const base of BASENAMES) {
      for (const extension of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
        const bytes = sizeOf(base, extension);
        expect(bytes, `${base}.${extension} is empty`).toBeGreaterThan(0);
        expect(bytes, `${base}.${extension} exceeds its budget`).toBeLessThanOrEqual(LIMITS[extension]);
      }
    }
  });

  test("keeps both video formats at or below 7.5 MB total", () => {
    const bytes = BASENAMES.reduce((total, base) =>
      total + sizeOf(base, "webm") + sizeOf(base, "mp4"), 0);
    expect(bytes).toBeLessThanOrEqual(7_500_000);
  });
});
