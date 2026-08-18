import { describe, expect, it } from "vitest";
import { splitOnQuote } from "./file-preview";

describe("splitOnQuote", () => {
  it("finds a quote across whitespace differences, case-insensitively", () => {
    const text = "Either party may terminate\n  this agreement with notice.";
    const parts = splitOnQuote(text, "may TERMINATE this agreement");
    expect(parts).not.toBeNull();
    expect(parts?.match).toBe("may terminate\n  this agreement");
    expect(parts?.before).toBe("Either party ");
  });

  it("escapes regex metacharacters in the quote", () => {
    const parts = splitOnQuote("the cap is $1,000 (net).", "$1,000 (net).");
    expect(parts?.match).toBe("$1,000 (net).");
  });

  it("returns null when the quote does not occur", () => {
    expect(splitOnQuote("some text", "absent words")).toBeNull();
  });

  it("returns null for an empty quote", () => {
    expect(splitOnQuote("some text", "   ")).toBeNull();
  });
});
