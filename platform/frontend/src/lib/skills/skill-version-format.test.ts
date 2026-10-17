// @vitest-environment node
import { describe, expect, it } from "vitest";
import { languageForPath } from "./skill-version-format";

describe("languageForPath", () => {
  it("reads the language off the extension", () => {
    expect(languageForPath("scripts/run.py")).toBe("python");
    expect(languageForPath("references/notes.md")).toBe("markdown");
    expect(languageForPath("config.yml")).toBe("yaml");
  });

  it("ignores extension case", () => {
    expect(languageForPath("DATA.JSON")).toBe("json");
  });

  it("falls back to plain text for anything unrecognised", () => {
    expect(languageForPath("assets/logo.psd")).toBe("plaintext");
  });

  it("treats a file with no extension as plain text", () => {
    expect(languageForPath("LICENSE")).toBe("plaintext");
  });
});
