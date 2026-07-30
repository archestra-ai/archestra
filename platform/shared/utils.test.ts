import { describe, expect, test } from "vitest";
import {
  collapseWhitespace,
  exceedsCharLimit,
  formatSecretStorageType,
  parseFullToolName,
  slugify,
  stripWrappingQuotes,
  truncateChars,
  truncateCharsWithEllipsis,
  urlSlugify,
} from "./utils";

describe("formatSecretStorageType", () => {
  test("formats known storage types", () => {
    expect(formatSecretStorageType("vault")).toBe("Vault");
    expect(formatSecretStorageType("external_vault")).toBe("External Vault");
    expect(formatSecretStorageType("database")).toBe("Database");
  });

  test("falls back to None", () => {
    expect(formatSecretStorageType("none")).toBe("None");
    expect(formatSecretStorageType(undefined)).toBe("None");
  });
});

describe("slugify", () => {
  test("creates URL-safe slugs", () => {
    expect(slugify("Hello World!")).toBe("hello_world");
    expect(slugify("__Already__Slugged__")).toBe("already_slugged");
  });
});

describe("urlSlugify", () => {
  test("creates hyphen-separated URL slugs", () => {
    expect(urlSlugify("Hello World!")).toBe("hello-world");
    expect(urlSlugify("My MCP Gateway")).toBe("my-mcp-gateway");
  });

  test("strips special characters", () => {
    expect(urlSlugify("Test @#$ Gateway!")).toBe("test-gateway");
    expect(urlSlugify("foo---bar")).toBe("foo-bar");
  });

  test("trims leading and trailing hyphens", () => {
    expect(urlSlugify("--Already--Slugged--")).toBe("already-slugged");
    expect(urlSlugify("  spaces  ")).toBe("spaces");
  });

  test("returns empty string for empty/symbol-only input", () => {
    expect(urlSlugify("")).toBe("");
    expect(urlSlugify("@#$%")).toBe("");
  });

  test("handles numeric names", () => {
    expect(urlSlugify("123 Test")).toBe("123-test");
  });
});

describe("parseFullToolName", () => {
  test("standard case: server__tool", () => {
    expect(parseFullToolName("outlook-abc__send_email")).toEqual({
      serverName: "outlook-abc",
      toolName: "send_email",
    });
  });

  test("server name containing __", () => {
    expect(parseFullToolName("upstash__context7__resolve-library-id")).toEqual({
      serverName: "upstash__context7",
      toolName: "resolve-library-id",
    });
  });

  test("no separator returns null serverName", () => {
    expect(parseFullToolName("send_email")).toEqual({
      serverName: null,
      toolName: "send_email",
    });
  });
});

/** Matches a high or low surrogate left without its partner. */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("collapseWhitespace", () => {
  test("collapses every run of whitespace onto one line", () => {
    expect(collapseWhitespace("Review this\n\n- one\t- two")).toBe(
      "Review this - one - two",
    );
  });

  test("trims the ends and flattens whitespace-only input to empty", () => {
    expect(collapseWhitespace("  padded  ")).toBe("padded");
    expect(collapseWhitespace(" \n\t ")).toBe("");
  });
});

describe("stripWrappingQuotes", () => {
  test("drops wrapping quotes and backticks", () => {
    expect(stripWrappingQuotes('"React Basics"')).toBe("React Basics");
    expect(stripWrappingQuotes("`Summarizes logs.`")).toBe("Summarizes logs.");
    expect(stripWrappingQuotes("'''quoted'''")).toBe("quoted");
  });

  test("keeps quotes that are part of the text", () => {
    expect(stripWrappingQuotes('Fixing the "off by one" bug')).toBe(
      'Fixing the "off by one" bug',
    );
  });
});

describe("exceedsCharLimit", () => {
  test("measures code points, not UTF-16 units", () => {
    // Ten emoji are ten characters but twenty UTF-16 units. Measuring with
    // `.length` would call this over a limit it actually fits inside.
    expect(exceedsCharLimit("🐛".repeat(10), 10)).toBe(false);
    expect(exceedsCharLimit("🐛".repeat(11), 10)).toBe(true);
  });

  test("handles the plain cases", () => {
    expect(exceedsCharLimit("", 5)).toBe(false);
    expect(exceedsCharLimit("exact", 5)).toBe(false);
    expect(exceedsCharLimit("exceeds", 5)).toBe(true);
  });
});

describe("truncateChars", () => {
  test("leaves text that already fits untouched", () => {
    expect(truncateChars("short", 10)).toBe("short");
    expect(truncateChars("exact", 5)).toBe("exact");
  });

  test("cuts to the character budget", () => {
    expect(truncateChars("truncate me", 8)).toBe("truncate");
  });

  test("never splits a surrogate pair", () => {
    // The odd-length prefix puts the cut inside a pair, which a raw UTF-16
    // slice would leave half of in the result.
    const cut = truncateChars(`Debug my ${"🐛".repeat(40)}`, 30);

    expect(cut).toBe(`Debug my ${"🐛".repeat(21)}`);
    expect(cut).not.toMatch(UNPAIRED_SURROGATE);
  });

  test("cuts input made entirely of surrogate pairs", () => {
    // The worst case for the bounded scan: every character costs two UTF-16
    // units, so the guaranteed-long-enough prefix is exactly twice the budget.
    // A prefix sized to the budget alone would count exactly `maxChars` here,
    // read as "already fits", and return the whole string uncut.
    expect(truncateChars("🐛".repeat(50), 4)).toBe("🐛".repeat(4));
  });
});

describe("truncateCharsWithEllipsis", () => {
  test("adds no ellipsis when the whole text is kept", () => {
    expect(truncateCharsWithEllipsis("Short prompt", 30)).toBe("Short prompt");
  });

  test("marks the cut and drops a space left dangling at it", () => {
    const cut = truncateCharsWithEllipsis(`${"word ".repeat(100)}end`, 30);

    // 30 characters of "word " end on a space, which is dropped rather than
    // padded back out — so this lands a character under the ceiling.
    expect(cut).toBe("word word word word word word…");
    // The budget covers the kept text; the ellipsis is added on top of it.
    expect(cut.length).toBeLessThanOrEqual(31);
  });
});
