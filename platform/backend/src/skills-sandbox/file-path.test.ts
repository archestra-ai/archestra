import path from "node:path";
import { describe, expect, test } from "@/test";
import { resolveWithinRoot, safeSegment, UnsafePathError } from "./file-path";

const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);

describe("safeSegment", () => {
  test("accepts ordinary names and emails, trimming whitespace", () => {
    expect(safeSegment("  report.pdf  ")).toBe("report.pdf");
    expect(safeSegment("user@example.com")).toBe("user@example.com");
    expect(safeSegment("My Project (2024)")).toBe("My Project (2024)");
  });

  for (const bad of ["", "   ", ".", "..", ".hidden", "a/b", "a\\b"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => safeSegment(bad)).toThrow(UnsafePathError);
    });
  }

  test("rejects NUL and control characters", () => {
    expect(() => safeSegment(`a${NUL}b`)).toThrow(UnsafePathError);
    expect(() => safeSegment("a\nb")).toThrow(UnsafePathError);
    expect(() => safeSegment(`a${DEL}b`)).toThrow(UnsafePathError);
  });

  test("rejects an over-long segment (>255 bytes)", () => {
    expect(() => safeSegment("a".repeat(256))).toThrow(UnsafePathError);
    expect(safeSegment("a".repeat(255))).toHaveLength(255);
  });
});

describe("resolveWithinRoot", () => {
  const root = "/srv/archestra_results";

  test("joins validated segments under the root", () => {
    expect(resolveWithinRoot(root, "user@example.com", "out.txt")).toBe(
      path.join(root, "user@example.com", "out.txt"),
    );
  });

  test("rejects traversal segments", () => {
    expect(() => resolveWithinRoot(root, "..", "etc")).toThrow(UnsafePathError);
    expect(() => resolveWithinRoot(root, "proj", "../../etc/passwd")).toThrow(
      UnsafePathError,
    );
  });

  test("rejects absolute-looking and separator-bearing segments", () => {
    expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrow(
      UnsafePathError,
    );
  });
});
