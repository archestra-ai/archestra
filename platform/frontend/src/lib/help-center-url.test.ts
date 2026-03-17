import { describe, expect, it } from "vitest";
import { isValidHelpCenterUrl } from "./help-center-url";

describe("isValidHelpCenterUrl", () => {
  it("accepts valid https URLs", () => {
    expect(
      isValidHelpCenterUrl("https://support.example.com/docs/getting-started"),
    ).toBe(true);
  });

  it("accepts valid http URLs", () => {
    expect(isValidHelpCenterUrl("http://localhost:8080/help")).toBe(true);
  });

  it("rejects invalid URLs", () => {
    expect(isValidHelpCenterUrl("not-a-url")).toBe(false);
  });

  it("rejects non-http protocols", () => {
    expect(isValidHelpCenterUrl("ftp://example.com/help")).toBe(false);
  });
});
