import { describe, expect, test } from "vitest";
import {
  ARCHESTRA_TOKEN_PREFIX,
  getArchestraTokenPrefix,
  hasArchestraTokenPrefix,
  isEditableTextFile,
  LEGACY_ARCHESTRA_TOKEN_PREFIXES,
} from "./consts";

describe("token prefix helpers", () => {
  test("matches the current token prefix", () => {
    expect(getArchestraTokenPrefix(`${ARCHESTRA_TOKEN_PREFIX}abc123`)).toBe(
      ARCHESTRA_TOKEN_PREFIX,
    );
    expect(hasArchestraTokenPrefix(`${ARCHESTRA_TOKEN_PREFIX}abc123`)).toBe(
      true,
    );
  });

  test("matches legacy token prefixes", () => {
    expect(
      getArchestraTokenPrefix(`${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}abc123`),
    ).toBe(LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]);
    expect(
      hasArchestraTokenPrefix(`${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}abc123`),
    ).toBe(true);
  });

  test("returns null for non-platform prefixes", () => {
    expect(getArchestraTokenPrefix("sk-abc123")).toBeNull();
    expect(hasArchestraTokenPrefix("sk-abc123")).toBe(false);
  });
});

describe("isEditableTextFile", () => {
  test("accepts .md and .txt by extension, case-insensitively", () => {
    for (const filename of ["notes.md", "NOTES.MD", "log.txt", "a.b.TxT"]) {
      expect(
        isEditableTextFile({ filename, mimeType: "application/octet-stream" }),
      ).toBe(true);
    }
  });

  test("accepts text/markdown and text/plain by MIME regardless of name", () => {
    expect(
      isEditableTextFile({ filename: "noext", mimeType: "text/markdown" }),
    ).toBe(true);
    expect(
      isEditableTextFile({ filename: "noext", mimeType: "TEXT/PLAIN" }),
    ).toBe(true);
  });

  test("rejects other text-ish and binary files (narrower than the preview kind)", () => {
    expect(
      isEditableTextFile({
        filename: "data.json",
        mimeType: "application/json",
      }),
    ).toBe(false);
    expect(
      isEditableTextFile({ filename: "table.csv", mimeType: "text/csv" }),
    ).toBe(false);
    expect(
      isEditableTextFile({ filename: "run.log", mimeType: "text/x-log" }),
    ).toBe(false);
    expect(
      isEditableTextFile({ filename: "page.html", mimeType: "text/html" }),
    ).toBe(false);
    expect(
      isEditableTextFile({ filename: "chart.png", mimeType: "image/png" }),
    ).toBe(false);
  });
});
