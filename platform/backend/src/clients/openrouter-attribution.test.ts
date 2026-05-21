import { describe, expect, test } from "@/test";
import { openRouterAttributionHeaders } from "./openrouter-attribution";

describe("openRouterAttributionHeaders", () => {
  test("sends the referer and both title header names", () => {
    const headers = openRouterAttributionHeaders();

    expect(headers["HTTP-Referer"]).toBeTruthy();
    // X-OpenRouter-Title is the current name; X-Title is the legacy alias.
    expect(headers["X-OpenRouter-Title"]).toBeTruthy();
    expect(headers["X-Title"]).toBe(headers["X-OpenRouter-Title"]);
  });

  test("sends the marketplace categories", () => {
    const headers = openRouterAttributionHeaders();

    expect(headers["X-OpenRouter-Categories"]).toBe(
      "general-chat,personal-agent",
    );
  });
});
