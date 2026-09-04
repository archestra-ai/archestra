import config from "@/config";
import { describe, expect, test } from "@/test";
import { openRouterAttributionHeaders } from "./openrouter-attribution";

describe("openRouterAttributionHeaders", () => {
  test("returns the configured attribution", () => {
    config.llm.openrouter.referer = "https://deployment.example";
    config.llm.openrouter.title = "Deployment";
    config.llm.openrouter.categories = "productivity";

    const headers = openRouterAttributionHeaders();

    expect(headers).toEqual({
      "HTTP-Referer": "https://deployment.example",
      "X-OpenRouter-Title": "Deployment",
      "X-Title": "Deployment",
      "X-OpenRouter-Categories": "productivity",
    });
  });

  test("lets caller attribution override configured defaults case-insensitively", () => {
    const headers = openRouterAttributionHeaders({
      "X-Custom-Auth": "keep-me",
      "http-referer": "https://caller.example",
      "x-OPENrouter-title": "Caller",
      "x-openrouter-categories": "roleplay,game",
      "X-OpenRouter-App-Visibility": "hidden",
    });

    expect(headers).toEqual({
      "X-Custom-Auth": "keep-me",
      "http-referer": "https://caller.example",
      "x-OPENrouter-title": "Caller",
      "x-openrouter-categories": "roleplay,game",
      "X-OpenRouter-App-Visibility": "hidden",
    });
  });
});
