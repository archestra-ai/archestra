import { describe, expect, test } from "vitest";
import { buildSkippedAttachmentsNote, formatApprovalToolArgs } from "./utils";

describe("formatApprovalToolArgs", () => {
  test("pretty-prints a non-empty arguments object", () => {
    const out = formatApprovalToolArgs({ repo: "octo/repo", count: 3 });
    expect(out).toBe('{\n  "repo": "octo/repo",\n  "count": 3\n}');
  });

  test("returns null for undefined or empty arguments", () => {
    expect(formatApprovalToolArgs(undefined)).toBeNull();
    expect(formatApprovalToolArgs({})).toBeNull();
  });

  test("truncates output that exceeds the max length", () => {
    const out = formatApprovalToolArgs({ blob: "x".repeat(5000) }, 100);
    expect(out).not.toBeNull();
    // 100 chars of JSON + the truncation marker.
    expect(out?.length).toBe(100 + "\n… (truncated)".length);
    expect(out?.endsWith("\n… (truncated)")).toBe(true);
  });

  test("returns null when arguments cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatApprovalToolArgs(circular)).toBeNull();
  });
});

describe("buildSkippedAttachmentsNote", () => {
  test("returns empty string when nothing was skipped", () => {
    expect(buildSkippedAttachmentsNote([])).toBe("");
  });

  test("names each skipped file so the model knows it existed", () => {
    const note = buildSkippedAttachmentsNote([
      { name: "IMG_0354.png", sizeBytes: 16_562_518, reason: "too_large" },
      { name: "notes.zip", reason: "download_failed" },
    ]);
    expect(note).not.toBe("");
    expect(note).toContain("IMG_0354.png");
    expect(note).toContain("notes.zip");
  });

  test("handles an unnamed file without throwing", () => {
    const note = buildSkippedAttachmentsNote([{ reason: "too_large" }]);
    expect(note).not.toBe("");
  });
});
