import { describe, expect, it } from "vitest";
import { parseArgumentsInput } from "./arguments-parser";

describe("parseArgumentsInput", () => {
  it("parses one argument per line", () => {
    expect(parseArgumentsInput("/path/to/server.js\n--verbose")).toEqual([
      "/path/to/server.js",
      "--verbose",
    ]);
  });

  it("parses a JSON array of arguments", () => {
    expect(
      parseArgumentsInput('["-y", "@modelcontextprotocol/server-github"]'),
    ).toEqual(["-y", "@modelcontextprotocol/server-github"]);
  });

  it("parses a JSON array with surrounding whitespace/newlines", () => {
    expect(parseArgumentsInput('\n  ["-y", "pkg"]  \n')).toEqual(["-y", "pkg"]);
  });

  it("coerces numbers inside a JSON array to strings", () => {
    expect(parseArgumentsInput('["--port", 8080]')).toEqual(["--port", "8080"]);
  });

  it("drops empty entries in a JSON array", () => {
    expect(parseArgumentsInput('["-y", "", "  ", "pkg"]')).toEqual([
      "-y",
      "pkg",
    ]);
  });

  it("falls back to line parsing for malformed JSON", () => {
    expect(parseArgumentsInput("[not-json\n--flag")).toEqual([
      "[not-json",
      "--flag",
    ]);
  });

  it("trims whitespace and ignores blank lines", () => {
    expect(parseArgumentsInput("  --a  \n\n   \n--b")).toEqual(["--a", "--b"]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseArgumentsInput("")).toEqual([]);
    expect(parseArgumentsInput("   \n  ")).toEqual([]);
  });

  it("returns an empty array for undefined/null", () => {
    expect(parseArgumentsInput(undefined)).toEqual([]);
    expect(parseArgumentsInput(null)).toEqual([]);
  });

  it("treats non-array JSON as a single line", () => {
    expect(parseArgumentsInput('{"a":1}')).toEqual(['{"a":1}']);
  });
});
