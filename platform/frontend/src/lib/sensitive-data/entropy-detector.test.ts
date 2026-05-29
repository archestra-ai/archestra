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

  // content hashes are entropy-identical to hex secrets, so an entropy
  // threshold cannot tell them apart. scoring against the base64-sized
  // reference alphabet keeps single-alphabet hex below the bar — these are
  // routinely pasted by developers and should not trigger the dialog.
  it("does not flag a sha256 digest", () => {
    const sha =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(scan(`digest: ${sha}`)).toEqual([]);
  });

  it("does not flag a 40-char git commit SHA", () => {
    const sha = "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a";
    expect(scan(`see commit ${sha} for the fix`)).toEqual([]);
  });

  it("does not flag an md5 digest", () => {
    const md5 = "9e107d9d372bb6826bd81d3542a419d6";
    expect(scan(`checksum ${md5}`)).toEqual([]);
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

  it("flags short random-looking tokens (~21 chars) that absolute thresholds would miss", () => {
    // 21 chars caps max entropy at log2(21) ≈ 4.39, so a fixed 4.5 threshold
    // could never fire. ratio-based threshold (0.85) handles this length.
    const token = "O1W7NxAA5bi7PWmQUNsks";
    const found = scan(`leaked: ${token}`);
    expect(found).toHaveLength(1);
    expect(found[0].internalLabel).toBe("high-entropy-token");
  });

  it("flags tokens containing punctuation that would split a stricter candidate regex", () => {
    // %, # are not in [A-Za-z0-9+/=_-]; without the \S{20,} candidate the
    // string would be split into sub-20 fragments and never scored.
    const token = "jmqK34hrlH6%ZQ#7D2HIm";
    const found = scan(token);
    expect(found).toHaveLength(1);
    expect(found[0].internalLabel).toBe("high-entropy-token");
  });

  it("skips URLs even when they contain high-entropy path segments", () => {
    // doc IDs in URLs look random; flagging them is annoying since users
    // routinely paste links. regex layer still catches keys-with-prefix in URLs.
    const url =
      "https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef/edit";
    expect(scan(url)).toEqual([]);
  });

  it("does not flag long natural-language compound words", () => {
    // exotic place names / Finnish / camelCase identifiers reach ~0.7-0.82
    // ratio — under the 0.85 threshold by a comfortable margin.
    const text =
      "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch " +
      "Lentokonesuihkuturbiinimoottoriapumekaanikkoaliupseerioppilas " +
      "getUserByEmailAndOrganizationIdFromDatabase";
    expect(scan(text)).toEqual([]);
  });
});
