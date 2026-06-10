import { describe, expect, it } from "vitest";
import { joinBaseUrl } from "./base-url";

describe("joinBaseUrl", () => {
  it("joins a base URL without a trailing slash", () => {
    expect(joinBaseUrl("https://api.anthropic.com", "/v1/models")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });

  it("trims a trailing slash so the path is not doubled", () => {
    expect(joinBaseUrl("https://api.anthropic.com/", "/v1/models")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });

  it("trims multiple trailing slashes", () => {
    expect(joinBaseUrl("http://localhost:8000/v1///", "/models")).toBe(
      "http://localhost:8000/v1/models",
    );
  });

  it("preserves a query string carried in the path", () => {
    expect(
      joinBaseUrl(
        "https://generativelanguage.googleapis.com/",
        "/v1beta/models?key=abc",
      ),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=abc");
  });
});
