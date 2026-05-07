import { describe, expect, it } from "vitest";
import { parseMcpArguments } from "./mcp-arguments-parser";

describe("parseMcpArguments", () => {
  it("should parse newline-separated arguments", () => {
    const input = "arg1\narg2\n  arg3  \n\narg4";
    const result = parseMcpArguments(input);
    expect(result).toEqual(["arg1", "arg2", "arg3", "arg4"]);
  });

  it("should parse JSON array of strings", () => {
    const input = '["arg1", "arg2", "arg3"]';
    const result = parseMcpArguments(input);
    expect(result).toEqual(["arg1", "arg2", "arg3"]);
  });

  it("should parse multi-line JSON array of strings", () => {
    const input = `[
      "arg1",
      "arg2",
      "arg3"
    ]`;
    const result = parseMcpArguments(input);
    expect(result).toEqual(["arg1", "arg2", "arg3"]);
  });

  it("should fallback to newline-splitting if JSON is invalid", () => {
    const input = '["arg1", "arg2"'; // Missing closing bracket
    const result = parseMcpArguments(input);
    expect(result).toEqual(['["arg1", "arg2"']);
  });

  it("should handle empty input", () => {
    expect(parseMcpArguments("")).toEqual([]);
    expect(parseMcpArguments("   ")).toEqual([]);
    expect(parseMcpArguments("\n\n")).toEqual([]);
  });

  it("should handle JSON with non-string elements by converting to string", () => {
    const input = '["arg1", 123, true]';
    const result = parseMcpArguments(input);
    expect(result).toEqual(["arg1", "123", "true"]);
  });

  it("should filter out empty arguments in both modes", () => {
    const input1 = "arg1\n\narg2";
    const input2 = '["arg1", "", "arg2"]';
    expect(parseMcpArguments(input1)).toEqual(["arg1", "arg2"]);
    expect(parseMcpArguments(input2)).toEqual(["arg1", "arg2"]);
  });
});
