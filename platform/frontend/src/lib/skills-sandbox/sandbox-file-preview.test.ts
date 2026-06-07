import { describe, expect, test } from "vitest";
import {
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
