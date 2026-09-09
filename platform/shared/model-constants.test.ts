import { describe, expect, test } from "vitest";
import {
  anthropicEffortForThinkingEffort,
  anthropicSupportsThinkingEffort,
  anthropicThinksByDefault,
  getAgentRuntimeModelCompatibility,
  getAgentRuntimeProviderCompatibility,
  getProvidersWithOptionalApiKey,
  isProviderApiKeyOptional,
  isSelfHostedProvider,
  isSmallModel,
  providerDisplayNames,
  providerSearchTerms,
  requiresOpenAiResponsesApi,
  resolveClaudeContextVariant,
  SMALL_MODEL_MAX_PARAMETERS,
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

describe("anthropicSupportsThinkingEffort", () => {
  test("offers a depth on models that already reason", () => {
    expect(anthropicSupportsThinkingEffort("claude-opus-5")).toBe(true);
    expect(anthropicSupportsThinkingEffort("claude-sonnet-5")).toBe(true);
    expect(anthropicSupportsThinkingEffort("claude-fable-5")).toBe(true);
    expect(anthropicSupportsThinkingEffort("claude-mythos-5")).toBe(true);
  });

  test("offers none where a depth would mean switching thinking on", () => {
    // These accept output_config.effort but keep thinking off until asked, so a
    // depth would move token spend without producing any reasoning.
    expect(anthropicSupportsThinkingEffort("claude-opus-4-8")).toBe(false);
    expect(anthropicSupportsThinkingEffort("claude-opus-4-7")).toBe(false);
    expect(anthropicSupportsThinkingEffort("claude-opus-4-6")).toBe(false);
    expect(anthropicSupportsThinkingEffort("claude-sonnet-4-6")).toBe(false);
  });

  test("offers none where the field is rejected outright", () => {
    expect(anthropicSupportsThinkingEffort("claude-sonnet-4-5")).toBe(false);
    expect(anthropicSupportsThinkingEffort("claude-haiku-4-5")).toBe(false);
    expect(anthropicSupportsThinkingEffort("claude-3-5-haiku-20241022")).toBe(
      false,
    );
  });
});

describe("anthropicEffortForThinkingEffort", () => {
  test.each([
    "low",
    "medium",
    "high",
  ] as const)("%s maps to itself, because the null default carries 'unchanged' instead", (effort) => {
    // Anthropic's own default is `high`, but a conversation nobody has
    // touched has no depth and never reaches here — so the levels mean what
    // they say rather than being shifted to keep one standing in for it.
    expect(anthropicEffortForThinkingEffort("claude-opus-5", effort)).toBe(
      effort,
    );
  });

  test("sends nothing for a model without a selectable depth", () => {
    expect(
      anthropicEffortForThinkingEffort("claude-sonnet-4-5", "high"),
    ).toBeNull();
    expect(
      anthropicEffortForThinkingEffort("claude-opus-4-8", "low"),
    ).toBeNull();
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

  test("matches Codex models and their variants", () => {
    expect(requiresOpenAiResponsesApi("gpt-5.3-codex")).toBe(true);
    expect(requiresOpenAiResponsesApi("gpt-5.2-codex-mini")).toBe(true);
    expect(requiresOpenAiResponsesApi("gpt-5.2-codex-2025-11-13")).toBe(true);
    expect(requiresOpenAiResponsesApi("openai/gpt-5.1-codex-max")).toBe(true);
  });

  test("does not match chat-completions models", () => {
    expect(requiresOpenAiResponsesApi("gpt-5.5")).toBe(false);
    expect(requiresOpenAiResponsesApi("gpt-4o")).toBe(false);
    expect(requiresOpenAiResponsesApi("babbage-002")).toBe(false);
    expect(requiresOpenAiResponsesApi("gpt-5.61")).toBe(false);
    expect(requiresOpenAiResponsesApi("gpt-5.3-codexical")).toBe(false);
  });
});

describe("getAgentRuntimeModelCompatibility", () => {
  test("applies maintained runtime provider requirements before protocol constraints", () => {
    expect(
      getAgentRuntimeModelCompatibility({
        inferenceProtocol: "anthropic",
        runtimeCommand: ["archestra-claude-code"],
        provider: "openai",
        modelId: "gpt-4o",
      }),
    ).toMatchObject({
      compatible: false,
      message: expect.stringContaining(
        "Claude Code runtime requires an Anthropic",
      ),
    });
    expect(
      getAgentRuntimeModelCompatibility({
        inferenceProtocol: "anthropic",
        runtimeCommand: ["archestra-claude-code"],
        provider: "anthropic",
        modelId: "claude-sonnet",
      }),
    ).toEqual({ compatible: true });
    expect(
      getAgentRuntimeModelCompatibility({
        inferenceProtocol: "openai_responses",
        runtimeCommand: ["archestra-codex"],
        provider: "gemini",
        modelId: "gemini-2.5-pro",
      }),
    ).toMatchObject({
      compatible: false,
      message: expect.stringContaining("Codex runtime requires an OpenAI"),
    });
  });

  test("allows only Claude Bedrock models for the maintained Claude Code runtime", () => {
    const runtime = {
      inferenceProtocol: "anthropic" as const,
      runtimeCommand: ["archestra-claude-code"],
      provider: "bedrock" as const,
    };

    // Key filtering has no selected model yet, so Bedrock remains available
    // until its model-specific eligibility is evaluated.
    expect(getAgentRuntimeProviderCompatibility(runtime)).toEqual({
      compatible: true,
    });
    for (const modelId of [
      "anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-sonnet-4-6",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6",
    ]) {
      expect(
        getAgentRuntimeModelCompatibility({ ...runtime, modelId }),
      ).toEqual({ compatible: true });
    }
    for (const modelId of ["amazon.nova-pro-v1:0", "google.gemini-2.5-pro"]) {
      expect(
        getAgentRuntimeModelCompatibility({ ...runtime, modelId }),
      ).toMatchObject({
        compatible: false,
        message: expect.stringContaining("requires a Claude model"),
      });
    }
  });

  test("leaves built-in and non-vendor maintained runtimes on protocol compatibility", () => {
    for (const { runtimeCommand, inferenceProtocol } of [
      { runtimeCommand: null, inferenceProtocol: "openai_responses" },
      {
        runtimeCommand: ["archestra-opencode"],
        inferenceProtocol: "openai_responses",
      },
      {
        runtimeCommand: ["archestra-hermes"],
        inferenceProtocol: "openai_chat",
      },
      {
        runtimeCommand: ["archestra-openclaw"],
        inferenceProtocol: "openai_chat",
      },
    ] as const) {
      expect(
        getAgentRuntimeModelCompatibility({
          inferenceProtocol,
          runtimeCommand,
          provider: "gemini",
          modelId: "gemini-2.5-pro",
        }),
      ).toEqual({ compatible: true });
    }
  });

  test("matches Anthropic, router-provider, and endpoint constraints", () => {
    expect(
      getAgentRuntimeModelCompatibility({
        inferenceProtocol: "anthropic",
        provider: "gemini",
        modelId: "gemini-2.5-pro",
      }),
    ).toMatchObject({
      compatible: false,
      message: expect.stringContaining("Anthropic API"),
    });
    expect(
      getAgentRuntimeModelCompatibility({
        inferenceProtocol: "openai_responses",
        provider: "ollama-native",
        modelId: "local-model",
      }),
    ).toMatchObject({
      compatible: false,
      message: expect.stringContaining("model router"),
    });
    expect(
      getAgentRuntimeModelCompatibility({
        inferenceProtocol: "openai_chat",
        provider: "github-copilot",
        modelId: "copilot-responses-only",
        supportedEndpoints: ["/responses"],
      }),
    ).toMatchObject({
      compatible: false,
      message: expect.stringContaining("Responses API"),
    });
    expect(
      getAgentRuntimeModelCompatibility({
        inferenceProtocol: "openai_chat",
        provider: "anthropic",
        modelId: "claude-sonnet",
      }),
    ).toEqual({ compatible: true });
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

  test("treats Anthropic as optional when keyless authentication is enabled", () => {
    expect(isProviderApiKeyOptional({ provider: "anthropic" })).toBe(false);
    expect(
      isProviderApiKeyOptional({
        provider: "anthropic",
        anthropicKeylessAuthEnabled: true,
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
      getProvidersWithOptionalApiKey({ anthropicKeylessAuthEnabled: true }),
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

describe("resolveClaudeContextVariant", () => {
  test("selects the explicit 1M variant for a Claude model with a 1M window", () => {
    expect(
      resolveClaudeContextVariant({
        modelId: "claude-opus-4-8",
        contextLength: 1_000_000,
      }),
    ).toBe("claude-opus-4-8[1m]");
  });

  test("leaves smaller, unknown, non-Claude, and already-marked models unchanged", () => {
    expect(
      resolveClaudeContextVariant({
        modelId: "claude-haiku-4-5",
        contextLength: 200_000,
      }),
    ).toBe("claude-haiku-4-5");
    expect(
      resolveClaudeContextVariant({
        modelId: "claude-uncatalogued",
        contextLength: null,
      }),
    ).toBe("claude-uncatalogued");
    expect(
      resolveClaudeContextVariant({
        modelId: "gpt-5.4",
        contextLength: 1_000_000,
      }),
    ).toBe("gpt-5.4");
    expect(
      resolveClaudeContextVariant({
        modelId: "claude-opus-4-8[1m]",
        contextLength: 1_000_000,
      }),
    ).toBe("claude-opus-4-8[1m]");
  });
});

describe("isSmallModel", () => {
  test("makes no claim when the serving backend reported no size", () => {
    // Only Ollama reports a parameter count today; everywhere else this is null
    // and the model must go unmarked rather than be assumed large or small.
    expect(isSmallModel(null)).toBe(false);
  });

  test("includes a model sitting exactly on the threshold", () => {
    expect(isSmallModel(SMALL_MODEL_MAX_PARAMETERS)).toBe(true);
  });

  test("marks models below the threshold and spares those above it", () => {
    expect(isSmallModel(1_000_000_000)).toBe(true);
    expect(isSmallModel(3_212_749_888)).toBe(true);
    expect(isSmallModel(8_030_261_248)).toBe(false);
    expect(isSmallModel(70_000_000_000)).toBe(false);
  });
});

describe("providerSearchTerms", () => {
  // The `vllm` entry is the generic OpenAI-compatible path, so an operator
  // searches it by the server they run, not by the engine it is named after.
  test.each([
    "llama.cpp",
    "LM Studio",
    "SGLang",
    "TGI",
    "LocalAI",
    // The old label, so nobody who already knows this entry as vLLM loses it.
    "vLLM",
  ])("makes the OpenAI-compatible entry reachable by %s", (term) => {
    expect(providerSearchTerms("vllm").toLowerCase()).toContain(
      term.toLowerCase(),
    );
  });

  test("is empty for providers whose own name is the only way to search them", () => {
    expect(providerSearchTerms("anthropic")).toBe("");
    expect(providerSearchTerms("openai")).toBe("");
  });

  test("labels the vLLM entry for the path it serves, not the one engine", () => {
    expect(providerDisplayNames.vllm).toBe("OpenAI-compatible");
  });
});
