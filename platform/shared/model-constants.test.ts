import { describe, expect, test } from "vitest";
import {
  anthropicThinksByDefault,
  getProvidersWithOptionalApiKey,
  isProviderApiKeyOptional,
  isSelfHostedProvider,
  requiresOpenAiResponsesApi,
  stripClaudeContextVariantSuffix,
} from "./model-constants";

describe("anthropicThinksByDefault", () => {
  test("matches models whose thinking is always on, including dated snapshots", () => {
    expect(anthropicThinksByDefault("claude-opus-5")).toBe(true);
    expect(anthropicThinksByDefault("claude-opus-5-20260724")).toBe(true);
    expect(anthropicThinksByDefault("claude-sonnet-5")).toBe(true);
    expect(anthropicThinksByDefault("claude-sonnet-5-20250929")).toBe(true);
    expect(anthropicThinksByDefault("claude-fable-5")).toBe(true);
    expect(anthropicThinksByDefault("claude-mythos-5")).toBe(true);
    expect(anthropicThinksByDefault("claude-mythos-preview")).toBe(true);
  });

  test("excludes models where thinking is off until requested", () => {
    // Opus 4.8/4.7 hide thinking text too (`display` defaults to "omitted"),
    // but thinking itself is off by default there — requesting it would add
    // cost, so they are deliberately not matched.
    expect(anthropicThinksByDefault("claude-opus-4-8")).toBe(false);
    expect(anthropicThinksByDefault("claude-opus-4-7")).toBe(false);
    // Nearest substring neighbor of the "opus-5" marker — must not match.
    expect(anthropicThinksByDefault("claude-opus-4-5-20251101")).toBe(false);
    expect(anthropicThinksByDefault("claude-sonnet-4-6")).toBe(false);
    expect(anthropicThinksByDefault("claude-sonnet-4-5")).toBe(false);
    expect(anthropicThinksByDefault("claude-3-5-haiku-20241022")).toBe(false);
  });
});

describe("requiresOpenAiResponsesApi", () => {
  test("matches pro reasoning models, including dated snapshots", () => {
    expect(requiresOpenAiResponsesApi("gpt-5.5-pro")).toBe(true);
    expect(requiresOpenAiResponsesApi("gpt-5.5-pro-2026-01-01")).toBe(true);
    expect(requiresOpenAiResponsesApi("o3-pro")).toBe(true);
  });

  test("matches the gpt-5.6 family, whose function tools require the Responses API", () => {
    expect(requiresOpenAiResponsesApi("gpt-5.6-sol")).toBe(true);
    expect(requiresOpenAiResponsesApi("gpt-5.6-terra")).toBe(true);
    expect(requiresOpenAiResponsesApi("gpt-5.6-luna")).toBe(true);
    expect(requiresOpenAiResponsesApi("gpt-5.6")).toBe(true);
    expect(requiresOpenAiResponsesApi("gpt-5.6-sol-2026-07-09")).toBe(true);
    expect(requiresOpenAiResponsesApi("openai/gpt-5.6-sol")).toBe(true);
  });

  test("does not match chat-completions models", () => {
    expect(requiresOpenAiResponsesApi("gpt-5.5")).toBe(false);
    expect(requiresOpenAiResponsesApi("gpt-4o")).toBe(false);
    expect(requiresOpenAiResponsesApi("babbage-002")).toBe(false);
    expect(requiresOpenAiResponsesApi("gpt-5.61")).toBe(false);
  });
});

describe("provider API key optional helpers", () => {
  test("treats self-hosted providers as optional", () => {
    expect(isProviderApiKeyOptional({ provider: "ollama" })).toBe(true);
    expect(isProviderApiKeyOptional({ provider: "ollama-native" })).toBe(true);
    expect(isProviderApiKeyOptional({ provider: "vllm" })).toBe(true);
  });

  test("treats Azure as optional only when Entra ID is enabled", () => {
    expect(isProviderApiKeyOptional({ provider: "azure" })).toBe(false);
    expect(
      isProviderApiKeyOptional({
        provider: "azure",
        azureEntraIdEnabled: false,
      }),
    ).toBe(false);
    expect(
      isProviderApiKeyOptional({
        provider: "azure",
        azureEntraIdEnabled: true,
      }),
    ).toBe(true);
  });

  test("treats Anthropic as optional only when Workload Identity Federation is enabled", () => {
    expect(isProviderApiKeyOptional({ provider: "anthropic" })).toBe(false);
    expect(
      isProviderApiKeyOptional({
        provider: "anthropic",
        anthropicWifEnabled: true,
      }),
    ).toBe(true);
  });

  test("lists providers with optional API keys", () => {
    expect(getProvidersWithOptionalApiKey()).toEqual([
      "ollama",
      "ollama-native",
      "vllm",
    ]);
    expect(
      getProvidersWithOptionalApiKey({ azureEntraIdEnabled: true }),
    ).toEqual(["ollama", "ollama-native", "vllm", "azure"]);
    expect(
      getProvidersWithOptionalApiKey({ anthropicWifEnabled: true }),
    ).toEqual(["ollama", "ollama-native", "vllm", "anthropic"]);
  });
});

describe("isSelfHostedProvider", () => {
  test("matches only the self-hosted providers", () => {
    expect(isSelfHostedProvider("ollama")).toBe(true);
    // Both Ollama transports are the same self-hosted server, so the
    // Docker-localhost hint has to apply to each. Coverage is transitive
    // through the shared set today; assert it directly so a future split
    // cannot silently drop one.
    expect(isSelfHostedProvider("ollama-native")).toBe(true);
    expect(isSelfHostedProvider("vllm")).toBe(true);
  });

  test("excludes cloud keyless providers (no per-provider denylist needed)", () => {
    // These are optional-key via runtime flags but are NOT self-hosted, so the
    // Docker-localhost hint must not apply to them.
    expect(isSelfHostedProvider("azure")).toBe(false);
    expect(isSelfHostedProvider("anthropic")).toBe(false);
    expect(isSelfHostedProvider("openai")).toBe(false);
  });
});

describe("stripClaudeContextVariantSuffix", () => {
  test("drops a context-variant marker from a Claude id", () => {
    // The marker names the same model: every Claude with a 1M window has it by
    // default, at standard pricing.
    expect(stripClaudeContextVariantSuffix("claude-opus-4-8[1m]")).toBe(
      "claude-opus-4-8",
    );
    expect(stripClaudeContextVariantSuffix("claude-sonnet-4-5[200k]")).toBe(
      "claude-sonnet-4-5",
    );
  });

  test("drops it from a reseller's Claude id too", () => {
    expect(
      stripClaudeContextVariantSuffix(
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0[1m]",
      ),
    ).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  test("leaves an unmarked id untouched", () => {
    expect(stripClaudeContextVariantSuffix("claude-opus-4-8")).toBe(
      "claude-opus-4-8",
    );
  });

  test("leaves a bracketed segment that is not a token count", () => {
    // Only a token-count marker is understood; anything else keeps its meaning.
    expect(stripClaudeContextVariantSuffix("claude-opus-4-8[beta]")).toBe(
      "claude-opus-4-8[beta]",
    );
  });

  test("leaves non-Claude ids alone", () => {
    expect(stripClaudeContextVariantSuffix("gpt-5.4[1m]")).toBe("gpt-5.4[1m]");
    expect(stripClaudeContextVariantSuffix("llama3-2-90b[1m]")).toBe(
      "llama3-2-90b[1m]",
    );
  });

  test("only strips a marker at the end of the id", () => {
    expect(stripClaudeContextVariantSuffix("claude-[1m]-opus")).toBe(
      "claude-[1m]-opus",
    );
  });
});
