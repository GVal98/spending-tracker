import { describe, expect, it } from "vitest";
import { audioFormatFromMimeType } from "./openrouter.js";

describe("audioFormatFromMimeType", () => {
  it.each([
    ["audio/ogg", "ogg"],
    ["audio/ogg; codecs=opus", "ogg"],
    ["audio/opus", "ogg"],
    ["audio/mpeg", "mp3"],
    ["audio/mp3", "mp3"],
    ["audio/wav", "wav"],
    ["audio/x-wav", "wav"],
    ["audio/mp4", "aac"],
    ["audio/x-m4a", "aac"],
    ["audio/flac", "flac"],
    ["AUDIO/OGG", "ogg"],
  ])("maps_%s_to_%s", (mimeType, format) => {
    expect(audioFormatFromMimeType(mimeType)).toBe(format);
  });

  it("falls_back_to_the_mime_subtype_for_unknown_types", () => {
    expect(audioFormatFromMimeType("audio/webm")).toBe("webm");
  });
});
