import { describe, expect, test } from "vitest";
import { toolCallArgumentsText } from "./tool-call-arguments";

describe("toolCallArgumentsText", () => {
  // GitHub Copilot's Chat Completions streams no argument text for a Claude
  // model's call to a tool without parameters.
  test.each(["", "  ", "\n"])("reads %j as an empty object", (text) => {
    expect(toolCallArgumentsText(text)).toBe("{}");
  });

  test("leaves argument text that is there as it is, cut off or not", () => {
    expect(toolCallArgumentsText('{"key":"value"}')).toBe('{"key":"value"}');
    expect(toolCallArgumentsText('{"key":"val')).toBe('{"key":"val');
  });
});
