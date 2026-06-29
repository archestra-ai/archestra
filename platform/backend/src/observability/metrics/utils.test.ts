import { describe, expect, test } from "@/test";
import { sanitizeLabelKey } from "./utils";

describe("sanitizeLabelKey", () => {
  test("passes through valid label keys unchanged", () => {
    expect(sanitizeLabelKey("environment")).toBe("environment");
    expect(sanitizeLabelKey("team_name")).toBe("team_name");
    expect(sanitizeLabelKey("abc123")).toBe("abc123");
  });

  test("replaces invalid characters with underscores", () => {
    expect(sanitizeLabelKey("my-label")).toBe("my_label");
    expect(sanitizeLabelKey("my.label")).toBe("my_label");
    expect(sanitizeLabelKey("my label")).toBe("my_label");
    expect(sanitizeLabelKey("my@label!")).toBe("my_label_");
  });

  test("prefixes with underscore if starts with a digit", () => {
    expect(sanitizeLabelKey("1abc")).toBe("_1abc");
    expect(sanitizeLabelKey("99bottles")).toBe("_99bottles");
  });

  test("handles keys that need both fixes", () => {
    expect(sanitizeLabelKey("1-bad-key")).toBe("_1_bad_key");
  });

  test("handles empty string", () => {
    expect(sanitizeLabelKey("")).toBe("");
  });
});
