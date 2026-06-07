import { describe, expect, test } from "vitest";
import {
  formatBytes,
  sandboxArtifactUrl,
  sandboxFilePreviewKind,
} from "./sandbox-file-preview";

describe("sandboxFilePreviewKind", () => {
  test("classifies images, text, and other", () => {
    expect(sandboxFilePreviewKind("image/png")).toBe("image");
    expect(sandboxFilePreviewKind("text/markdown")).toBe("text");
    expect(sandboxFilePreviewKind("application/json")).toBe("text");
    expect(sandboxFilePreviewKind("application/pdf")).toBe("none");
  });
});

describe("sandboxArtifactUrl", () => {
  test("builds the artifact byte route", () => {
    expect(sandboxArtifactUrl("abc")).toBe("/api/skill-sandbox/artifacts/abc");
  });
});

describe("formatBytes", () => {
  test("formats bytes, kilobytes, and megabytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
