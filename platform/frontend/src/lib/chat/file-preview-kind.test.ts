import { describe, expect, it } from "vitest";
import { getFilePreviewKind } from "@/lib/chat/file-preview-kind";

describe("getFilePreviewKind", () => {
  it("treats markdown by mime or .md extension", () => {
    expect(getFilePreviewKind("text/markdown", "artifact.md")).toBe("markdown");
    expect(getFilePreviewKind("application/octet-stream", "notes.md")).toBe(
      "markdown",
    );
  });

  it("renders only the inline-safe image whitelist as image", () => {
    for (const m of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(getFilePreviewKind(m, "x")).toBe("image");
    }
    expect(getFilePreviewKind("image/bmp", "x.bmp")).toBe("unsupported");
  });

  it("treats svg by mime or .svg extension", () => {
    expect(getFilePreviewKind("image/svg+xml", "x")).toBe("svg");
    expect(getFilePreviewKind("application/octet-stream", "logo.svg")).toBe(
      "svg",
    );
  });

  it("detects html by mime or extension, before generic text", () => {
    expect(getFilePreviewKind("text/html", "page")).toBe("html");
    expect(getFilePreviewKind("application/octet-stream", "report.html")).toBe(
      "html",
    );
    expect(getFilePreviewKind("application/octet-stream", "x.htm")).toBe(
      "html",
    );
  });

  it("detects csv before generic text", () => {
    expect(getFilePreviewKind("text/csv", "data")).toBe("csv");
    expect(getFilePreviewKind("application/octet-stream", "data.csv")).toBe(
      "csv",
    );
  });

  it("treats text/* and json as text", () => {
    expect(getFilePreviewKind("text/plain", "a.txt")).toBe("text");
    expect(getFilePreviewKind("application/json", "a.json")).toBe("text");
  });

  it("renders PDFs via the browser's own viewer", () => {
    expect(getFilePreviewKind("application/pdf", "a.pdf")).toBe("pdf");
    // Sniffed uploads often arrive as octet-stream; the extension decides.
    expect(getFilePreviewKind("application/octet-stream", "a.pdf")).toBe("pdf");
  });

  it("falls back to unsupported", () => {
    expect(
      getFilePreviewKind(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "a.xlsx",
      ),
    ).toBe("unsupported");
  });
});

it("falls back to text for txt/log/json extensions when the mime is opaque", () => {
  expect(getFilePreviewKind("application/octet-stream", "result (1).txt")).toBe(
    "text",
  );
  expect(getFilePreviewKind("application/octet-stream", "run.log")).toBe(
    "text",
  );
  expect(getFilePreviewKind("application/octet-stream", "data.json")).toBe(
    "text",
  );
});
