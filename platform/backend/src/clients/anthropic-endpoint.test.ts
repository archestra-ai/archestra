import { describe, expect, it } from "vitest";
import {
  isAnthropicNativeEndpoint,
  isNativeAnthropicModelShape,
} from "./anthropic-endpoint";

describe("isAnthropicNativeEndpoint", () => {
  it("non-Claude model behind a custom base URL is NOT native", () => {
    expect(
      isAnthropicNativeEndpoint({
        provider: "anthropic",
        model: "kimi-k2",
        baseUrl: "https://moonshot.example/v1",
      }),
    ).toBe(false);
  });

  it("no base-URL override is native", () => {
    expect(
      isAnthropicNativeEndpoint({
        provider: "anthropic",
        model: "kimi-k2",
        baseUrl: null,
      }),
    ).toBe(true);
  });

  it("a Claude model stays native even behind a custom base URL", () => {
    expect(
      isAnthropicNativeEndpoint({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        baseUrl: "https://gateway.example/v1",
      }),
    ).toBe(true);
  });

  it("a non-Anthropic provider is never native Anthropic", () => {
    expect(
      isAnthropicNativeEndpoint({
        provider: "openai",
        model: "gpt-5.4",
        baseUrl: "https://custom.example/v1",
      }),
    ).toBe(false);
    expect(
      isAnthropicNativeEndpoint({
        provider: "openai",
        model: "gpt-5.4",
        baseUrl: null,
      }),
    ).toBe(false);
  });
});

describe("isNativeAnthropicModelShape (shared core)", () => {
  it("matches the header-forwarding truth table", () => {
    expect(isNativeAnthropicModelShape("kimi-k2", false)).toBe(true);
    expect(isNativeAnthropicModelShape("kimi-k2", true)).toBe(false);
    expect(isNativeAnthropicModelShape("claude-opus-4-8", true)).toBe(true);
  });
});
