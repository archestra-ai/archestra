import { describe, expect, it } from "vitest";
import { nextAvailableName, sanitizeUploadFilename } from "./upload-filename";

describe("sanitizeUploadFilename", () => {
  it("passes through an ordinary name", () => {
    expect(sanitizeUploadFilename("report.pdf")).toBe("report.pdf");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeUploadFilename("  report.pdf  ")).toBe("report.pdf");
  });

  it("strips POSIX path components, keeping the basename", () => {
    expect(sanitizeUploadFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeUploadFilename("../../secret.txt")).toBe("secret.txt");
  });

  it("strips Windows path components, keeping the basename", () => {
    expect(sanitizeUploadFilename("C:\\Users\\me\\report.pdf")).toBe(
      "report.pdf",
    );
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(() => sanitizeUploadFilename("")).toThrow(/empty/i);
    expect(() => sanitizeUploadFilename("   ")).toThrow(/empty/i);
  });

  it("rejects a name that is only a path", () => {
    expect(() => sanitizeUploadFilename("foo/")).toThrow(/empty/i);
  });

  it('rejects "." and ".."', () => {
    expect(() => sanitizeUploadFilename(".")).toThrow(/invalid/i);
    expect(() => sanitizeUploadFilename("..")).toThrow(/invalid/i);
  });

  it("rejects NUL and control characters", () => {
    expect(() => sanitizeUploadFilename("re\x00port.pdf")).toThrow(/invalid/i);
    expect(() => sanitizeUploadFilename("re\nport.pdf")).toThrow(/invalid/i);
    expect(() => sanitizeUploadFilename("re\x7fport.pdf")).toThrow(/invalid/i);
  });

  it("rejects an over-length name", () => {
    expect(() => sanitizeUploadFilename(`${"a".repeat(256)}.pdf`)).toThrow(
      /too long/i,
    );
  });

  it("accepts a name exactly at the length limit", () => {
    const name = "a".repeat(255);
    expect(sanitizeUploadFilename(name)).toBe(name);
  });

  it("rejects dotfiles, matching the object store's segment policy", () => {
    expect(() => sanitizeUploadFilename(".gitignore")).toThrow(/invalid/i);
  });
});

describe("nextAvailableName", () => {
  it("appends the attempt index before the extension", () => {
    expect(nextAvailableName("report.pdf", 1)).toBe("report (1).pdf");
    expect(nextAvailableName("report.pdf", 2)).toBe("report (2).pdf");
  });

  it("treats the last dot as the extension boundary", () => {
    expect(nextAvailableName("archive.tar.gz", 1)).toBe("archive.tar (1).gz");
  });

  it("treats a trailing dot as an empty extension", () => {
    expect(nextAvailableName("report.", 1)).toBe("report (1).");
  });

  it("treats a dotfile as having no extension", () => {
    expect(nextAvailableName(".gitignore", 1)).toBe(".gitignore (1)");
  });

  it("treats an extensionless name as having no extension", () => {
    expect(nextAvailableName("README", 3)).toBe("README (3)");
  });

  it("does not stack an existing index suffix", () => {
    expect(nextAvailableName("report (1).pdf", 2)).toBe("report (2).pdf");
    expect(nextAvailableName("README (4)", 5)).toBe("README (5)");
  });

  it("truncates the base so the result stays within the byte cap", () => {
    const result = nextAvailableName(`${"a".repeat(255)}.pdf`, 1);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(255);
    expect(result.endsWith(" (1).pdf")).toBe(true);
  });

  it("stays within the byte cap even with a pathologically long extension", () => {
    // Tiny base, ~253-byte extension — the suffix must still fit.
    const result = nextAvailableName(`a.${"x".repeat(252)}`, 1);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(255);
    expect(result.includes(" (1)")).toBe(true);
  });
});
