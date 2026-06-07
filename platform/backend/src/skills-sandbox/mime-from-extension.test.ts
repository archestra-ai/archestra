import { describe, expect, test } from "vitest";
import { mimeFromExtension } from "./mime-from-extension";

describe("mimeFromExtension", () => {
  test("maps common extensions case-insensitively", () => {
    expect(mimeFromExtension("report.PDF")).toBe("application/pdf");
    expect(mimeFromExtension("a.png")).toBe("image/png");
    expect(mimeFromExtension("notes.txt")).toBe("text/plain");
    expect(mimeFromExtension("data.json")).toBe("application/json");
    expect(mimeFromExtension("t.csv")).toBe("text/csv");
  });

  test("defaults to application/octet-stream for unknown/missing extensions", () => {
    expect(mimeFromExtension("archive.xyz")).toBe("application/octet-stream");
    expect(mimeFromExtension("noext")).toBe("application/octet-stream");
  });
});
