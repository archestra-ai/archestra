import { describe, expect, test } from "vitest";
import {
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  openCodePassthroughBaseUrl,
} from "./opencode-provider-routes";

describe("OpenCode passthrough provider routes", () => {
  test("preserves native provider ids and maps each wire to its proxy base URL", () => {
    expect(
      Object.fromEntries(
        OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => [
          route.openCodeProviderId,
          openCodePassthroughBaseUrl("https://example.com/v1/", route),
        ]),
      ),
    ).toEqual({
      anthropic: "https://example.com/v1/anthropic/v1",
      google: "https://example.com/v1/gemini/v1beta",
      openai: "https://example.com/v1/openai",
      cerebras: "https://example.com/v1/cerebras",
      mistral: "https://example.com/v1/mistral",
      groq: "https://example.com/v1/groq",
      openrouter: "https://example.com/v1/openrouter",
      deepseek: "https://example.com/v1/deepseek",
      zhipuai: "https://example.com/v1/zhipuai",
      minimax: "https://example.com/v1/minimax",
      moonshotai: "https://example.com/v1/kimi",
    });
  });
});
