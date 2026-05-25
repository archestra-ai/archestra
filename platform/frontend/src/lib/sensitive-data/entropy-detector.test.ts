import { describe, expect, it } from "vitest";

import { entropyDetector, shannonEntropy } from "./entropy-detector";
import { regexDetector } from "./regex-detector";
import { detectorId, type Finding } from "./types";

const scan = (text: string, existingFindings: Finding[] = []) =>
  entropyDetector.scan(text, { existingFindings });

describe("shannonEntropy", () => {
  it("returns 0 for an empty string", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("returns 0 for a single repeated character", () => {
    expect(shannonEntropy("aaaaaaaaaa")).toBe(0);
  });

  it("returns 1 for a perfectly balanced two-character alphabet", () => {
    expect(shannonEntropy("abab")).toBeCloseTo(1, 5);
  });

  it("returns higher values for more random strings", () => {
    const low = shannonEntropy("aaaaaaaabbbbbbbb");
    const high = shannonEntropy("aB3$xY7!qZ9@mN2#");
    expect(high).toBeGreaterThan(low);
  });
});

describe("entropyDetector", () => {
  it("returns no findings for ordinary English prose", () => {
    const text =
      "The quick brown fox jumps over the lazy dog and runs across the meadow.";
    expect(scan(text)).toEqual([]);
  });

  it("flags a high-entropy standard base64 token containing slashes", () => {
    // standard base64 (not URL-safe) uses '+' and '/' — secrets like AWS secret keys use this
    const token = "aB3+Y7/Z9mN2pR5wL8vK4tH6jC1fG0sD";
    const found = scan(`secret=${token}`);
    expect(found).toHaveLength(1);
    expect(found[0].internalLabel).toBe("high-entropy-token");
  });

  it("does not flag URL paths as high-entropy tokens", () => {
    const url =
      "https://cdn.example.com/static/assets/v3/ab2x9z1q/main-8f3a.min.js";
    expect(scan(url)).toEqual([]);
  });

  it("ignores short tokens below the length threshold", () => {
    expect(scan("abc123 def456 ghi789")).toEqual([]);
  });

  it("flags a high-entropy base64-like token", () => {
    const token = "aB3xY7qZ9mN2pR5wL8vK4tH6jC1fG0sD";
    const found = scan(`prefix ${token} suffix`);
    expect(found).toHaveLength(1);
    expect(found[0].internalLabel).toBe("high-entropy-token");
    expect(found[0].startIndex).toBe("prefix ".length);
    expect(found[0].endIndex).toBe("prefix ".length + token.length);
  });

  it("flags a hex-like SHA-style digest", () => {
    const sha =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const found = scan(`digest: ${sha}`);
    expect(found).toHaveLength(1);
    expect(found[0].internalLabel).toBe("high-entropy-token");
  });

  it("does not flag a long low-entropy token", () => {
    const token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(scan(token)).toEqual([]);
  });

  it("skips tokens whose range overlaps an existing finding", () => {
    const token = "aB3xY7qZ9mN2pR5wL8vK4tH6jC1fG0sD";
    const text = `value=${token}`;
    const existing: Finding[] = [
      {
        detectorId: detectorId("regex"),
        internalLabel: "some-rule",
        startIndex: text.indexOf(token),
        endIndex: text.indexOf(token) + token.length,
      },
    ];
    expect(scan(text, existing)).toEqual([]);
  });

  it("skips tokens whose range partially overlaps an existing finding", () => {
    const token = "aB3xY7qZ9mN2pR5wL8vK4tH6jC1fG0sD";
    const text = `value=${token}`;
    const tokenStart = text.indexOf(token);
    const existing: Finding[] = [
      {
        detectorId: detectorId("regex"),
        internalLabel: "some-rule",
        startIndex: tokenStart - 2,
        endIndex: tokenStart + 5,
      },
    ];
    expect(scan(text, existing)).toEqual([]);
  });

  it("does not skip tokens whose range is disjoint from existing findings", () => {
    const token = "aB3xY7qZ9mN2pR5wL8vK4tH6jC1fG0sD";
    const text = `first AKIAIOSFODNN7EXAMPLE then ${token}`;
    const existing: Finding[] = [
      {
        detectorId: detectorId("regex"),
        internalLabel: "aws-access-key",
        startIndex: text.indexOf("AKIA"),
        endIndex: text.indexOf("AKIA") + "AKIAIOSFODNN7EXAMPLE".length,
      },
    ];
    const found = scan(text, existing);
    expect(found).toHaveLength(1);
    expect(text.slice(found[0].startIndex, found[0].endIndex)).toBe(token);
  });

  it("does not double-flag a token that the regex detector already caught", () => {
    const ghToken = "ghp_aB3xY7qZ9mN2pR5wL8vK4tH6jC1fG0sDaB3xY7qZ9mN2pR5wL8";
    const text = `token=${ghToken}`;
    const regexFindings = regexDetector.scan(text, { existingFindings: [] });
    expect(regexFindings.length).toBeGreaterThan(0);
    expect(scan(text, regexFindings)).toEqual([]);
  });
});
