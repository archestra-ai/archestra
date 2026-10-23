import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  it.each([
    [new Error("boom"), "boom"],
    ["plain text", "plain text"],
    [{ code: -32603, message: "Tool failed" }, "Tool failed"],
    [{ code: 42 }, '{"code":42}'],
    [undefined, "undefined"],
  ])("describes %o as %s", (error, expected) => {
    expect(errorMessage(error)).toBe(expected);
  });
});
