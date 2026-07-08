import { describe, expect, test } from "vitest";
import { pickStreamSource, STREAM_SOURCES } from "./radio";

// canPlayType() maps a MIME to "probably" | "maybe" | "" — build a stub from a
// lookup table so each test can mimic a specific browser's decoder support.
function canPlay(support: Record<string, string>): (mime: string) => string {
  return (mime) => support[mime] ?? "";
}

describe("pickStreamSource", () => {
  test("MP3 (audio/mpeg) is the preferred candidate, Ogg the fallback", () => {
    expect(STREAM_SOURCES[0].mime).toBe("audio/mpeg");
    expect(STREAM_SOURCES[0].url).toBe("https://stream.nightride.fm/nightride.mp3");
    expect(STREAM_SOURCES[STREAM_SOURCES.length - 1].url).toBe(
      "https://stream.nightride.fm/nightride.ogg",
    );
  });

  test("iOS Safari (Ogg unsupported, MP3 'maybe') picks the MP3 stream", () => {
    const source = pickStreamSource(
      canPlay({ "audio/mpeg": "maybe", 'audio/ogg; codecs="opus"': "" }),
    );
    expect(source?.url).toBe("https://stream.nightride.fm/nightride.mp3");
  });

  test("Chrome (everything 'probably') picks the first in preferred order", () => {
    const source = pickStreamSource(() => "probably");
    expect(source).toEqual(STREAM_SOURCES[0]);
  });

  test("an Ogg-only browser falls back to the Ogg stream", () => {
    const source = pickStreamSource(
      canPlay({ "audio/mpeg": "", 'audio/ogg; codecs="opus"': "maybe" }),
    );
    expect(source?.url).toBe("https://stream.nightride.fm/nightride.ogg");
  });

  test("no decodable format returns null (caller keeps current no-crash behavior)", () => {
    expect(pickStreamSource(() => "")).toBeNull();
  });
});
