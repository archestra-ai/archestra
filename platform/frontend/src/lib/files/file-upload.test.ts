import { describe, expect, it } from "vitest";
import {
  summarizeUploadResults,
  type UploadOutcome,
  validateUploadFile,
} from "./file-upload";

const MAX = 25 * 1024 * 1024;

describe("validateUploadFile", () => {
  it("accepts a normal-sized file", () => {
    expect(validateUploadFile({ size: 1024 }, MAX)).toEqual({ ok: true });
  });

  it("accepts a file exactly at the limit", () => {
    expect(validateUploadFile({ size: MAX }, MAX)).toEqual({ ok: true });
  });

  it("rejects a zero-byte file as empty", () => {
    expect(validateUploadFile({ size: 0 }, MAX)).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("rejects a file one byte over the limit", () => {
    expect(validateUploadFile({ size: MAX + 1 }, MAX)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("summarizeUploadResults", () => {
  const ok = (name: string): UploadOutcome => ({ name, ok: true });
  const fail = (
    name: string,
    reason: UploadOutcome["reason"],
  ): UploadOutcome => ({
    name,
    ok: false,
    reason,
  });

  it("returns nothing for an empty batch", () => {
    expect(summarizeUploadResults([], 25)).toEqual([]);
  });

  it("reports a single success", () => {
    expect(summarizeUploadResults([ok("a.txt")], 25)).toEqual([
      { type: "success", message: "File uploaded" },
    ]);
  });

  it("reports multiple successes with a count", () => {
    expect(summarizeUploadResults([ok("a"), ok("b"), ok("c")], 25)).toEqual([
      { type: "success", message: "Uploaded 3 files" },
    ]);
  });

  it("gives an over-limit file its own actionable toast and no generic error", () => {
    expect(summarizeUploadResults([fail("big.zip", "too_large")], 25)).toEqual([
      { type: "error", message: "big.zip is too large (max 25 MB)" },
    ]);
  });

  it("summarizes a mixed batch", () => {
    expect(summarizeUploadResults([ok("a"), fail("b", "server")], 25)).toEqual([
      { type: "error", message: "Uploaded 1 of 2; 1 failed" },
    ]);
  });

  it("reports an all-server-failure batch", () => {
    expect(
      summarizeUploadResults([fail("a", "server"), fail("b", "server")], 25),
    ).toEqual([{ type: "error", message: "Upload failed" }]);
  });

  it("still surfaces a server failure when another file was rejected client-side", () => {
    // Regression: zero successes + a client rejection must not hide the server error.
    expect(
      summarizeUploadResults(
        [fail("big.zip", "too_large"), fail("b.txt", "server")],
        25,
      ),
    ).toEqual([
      { type: "error", message: "big.zip is too large (max 25 MB)" },
      { type: "error", message: "Upload failed" },
    ]);
  });
});
