import { describe, expect, test } from "vitest";
import {
  getAcceptedFileTypes,
  getMediaType,
  getSupportedFileTypesDescription,
  INPUT_MODALITY_OPTIONS,
  OUTPUT_MODALITY_OPTIONS,
  supportsFileUploads,
} from "./chat";

describe("chat file upload helpers", () => {
  test("treats text modality as supporting txt, md, and csv uploads", () => {
    expect(getAcceptedFileTypes(["text"])).toBe(
      [
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
      ].join(","),
    );
    expect(supportsFileUploads(["text"])).toBe(true);
    expect(getSupportedFileTypesDescription(["text"])).toBe(
      "chat prompts, .txt, .csv, and .md uploads",
    );
  });

  test("deduplicates mime types across modalities", () => {
    expect(getAcceptedFileTypes(["text", "text", "pdf"])).toBe(
      [
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
        "application/pdf",
      ].join(","),
    );
  });

  test("returns no file types when modalities are missing", () => {
    expect(getAcceptedFileTypes(null)).toBeUndefined();
    expect(getAcceptedFileTypes(undefined)).toBeUndefined();
    expect(getAcceptedFileTypes([])).toBeUndefined();
    expect(supportsFileUploads(null)).toBe(false);
    expect(getSupportedFileTypesDescription(undefined)).toBeNull();
  });

  test("builds a readable description for multiple upload modalities", () => {
    expect(
      getSupportedFileTypesDescription(["text", "image", "pdf", "audio"]),
    ).toBe("chat prompts, .txt, .csv, and .md uploads, images, PDFs, audio");
  });

  test("uses explicit file media types when present", () => {
    expect(getMediaType({ name: "notes.txt", type: "text/markdown" })).toBe(
      "text/markdown",
    );
  });

  test("falls back to extension-based media type detection", () => {
    expect(getMediaType({ name: "report.pdf", type: "" })).toBe(
      "application/pdf",
    );
    expect(getMediaType({ name: "table.csv", type: "" })).toBe("text/csv");
    expect(getMediaType({ name: "README.md", type: "" })).toBe("text/markdown");
    expect(getMediaType({ name: "readme.txt", type: "" })).toBe("text/plain");
  });

  test("defaults unknown extensions to application/octet-stream", () => {
    expect(getMediaType({ name: "archive.bin", type: "" })).toBe(
      "application/octet-stream",
    );
    expect(getMediaType({ name: "no-extension", type: "" })).toBe(
      "application/octet-stream",
    );
  });

  test("exports exhaustive input and output modality option metadata", () => {
    expect(INPUT_MODALITY_OPTIONS.map((option) => option.value)).toEqual([
      "text",
      "image",
      "audio",
      "video",
      "pdf",
    ]);
    expect(OUTPUT_MODALITY_OPTIONS.map((option) => option.value)).toEqual([
      "text",
      "image",
      "audio",
    ]);
  });
});
