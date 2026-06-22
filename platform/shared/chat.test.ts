import { describe, expect, test } from "vitest";
import {
  getAcceptedFileTypes,
  getMediaType,
  getSupportedFileTypesDescription,
  hasPersistableAssistantContent,
  INPUT_MODALITY_OPTIONS,
  OUTPUT_MODALITY_OPTIONS,
  supportsFileUploads,
} from "./chat";

describe("chat file upload helpers", () => {
  test("treats text modality as supporting txt, md, csv, and json uploads", () => {
    expect(getAcceptedFileTypes(["text"])).toBe(
      [
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
        "application/json",
      ].join(","),
    );
    expect(supportsFileUploads(["text"])).toBe(true);
    expect(getSupportedFileTypesDescription(["text"])).toBe(
      "chat prompts, .txt, .csv, .md, and .json uploads",
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
        "application/json",
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
    ).toBe(
      "chat prompts, .txt, .csv, .md, and .json uploads, images, PDFs, audio",
    );
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

describe("hasPersistableAssistantContent", () => {
  test("keeps assistant turns carrying renderable content", () => {
    expect(
      hasPersistableAssistantContent({
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toBe(true);
  });

  test("drops empty turns", () => {
    expect(hasPersistableAssistantContent({})).toBe(false);
    expect(hasPersistableAssistantContent({ parts: [] })).toBe(false);
    expect(
      hasPersistableAssistantContent({ parts: [{ type: "text", text: "  " }] }),
    ).toBe(false);
  });

  // read-path callers pass historical JSON that is only cast, so malformed
  // rows must be treated as empty rather than throwing and failing the load.
  test("tolerates malformed persisted parts without throwing", () => {
    const malformed = [
      { parts: {} },
      { parts: [{}] },
      { parts: [null] },
      { parts: [{ type: 42 }] },
      { parts: "not-an-array" },
    ];
    for (const message of malformed) {
      expect(
        hasPersistableAssistantContent(
          message as Parameters<typeof hasPersistableAssistantContent>[0],
        ),
      ).toBe(false);
    }
  });
});
