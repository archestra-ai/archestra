import { describe, expect, it } from "vitest";
import { resolveSpeechRecognitionLocale } from "./speech-locale";

describe("resolveSpeechRecognitionLocale", () => {
  it("keeps a region the browser already reports", () => {
    expect(resolveSpeechRecognitionLocale(["en-GB", "en"])).toBe("en-GB");
  });

  it("expands a language-only preference to its likely region", () => {
    // Recognizers are region-sensitive, so `de` alone would leave the engine
    // picking for us.
    expect(resolveSpeechRecognitionLocale(["de"])).toBe("de-DE");
    expect(resolveSpeechRecognitionLocale(["ja"])).toBe("ja-JP");
  });

  it("normalizes casing and drops the script subtag", () => {
    expect(resolveSpeechRecognitionLocale(["zh-Hant-TW"])).toBe("zh-TW");
    expect(resolveSpeechRecognitionLocale(["PT-br"])).toBe("pt-BR");
  });

  it("falls back to the next usable preference", () => {
    expect(resolveSpeechRecognitionLocale(["", "  ", "fr-CA"])).toBe("fr-CA");
  });

  it("returns undefined when the browser exposes nothing usable", () => {
    expect(resolveSpeechRecognitionLocale([])).toBeUndefined();
    expect(resolveSpeechRecognitionLocale(undefined)).toBeUndefined();
    expect(resolveSpeechRecognitionLocale(["not a locale!"])).toBeUndefined();
  });
});
