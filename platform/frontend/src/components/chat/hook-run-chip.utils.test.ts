import { describe, expect, it } from "vitest";
import { prettyPrintJson } from "./hook-run-chip.utils";

describe("prettyPrintJson", () => {
  it("indents valid JSON", () => {
    expect(prettyPrintJson('{"a":1,"b":{"c":2}}')).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}',
    );
  });

  it("returns the raw string when it is not valid JSON (e.g. truncated)", () => {
    const truncated = '{"tool_name":"bash"…[truncated 1200 chars]';
    expect(prettyPrintJson(truncated)).toBe(truncated);
  });

  it("leaves an empty string untouched", () => {
    expect(prettyPrintJson("")).toBe("");
  });
});
