import { describe, expect, it } from "vitest";
import {
  connectionModelServesClient,
  copilotCliUsesResponsesWire,
  defaultConnectionModel,
  NATIVE_SESSION_CLIENT_LABELS,
} from "./connection-setup";

describe("Copilot CLI wire selection", () => {
  it.each([
    "openai",
    "azure",
    "github-copilot",
    "xai",
  ] as const)("selects the Responses API on %s, where the proxy serves it", (provider) => {
    expect(copilotCliUsesResponsesWire(provider)).toBe(true);
  });

  it.each([
    "groq",
    "mistral",
    "openrouter",
    "ollama",
    "vllm",
    "deepseek",
    "cerebras",
  ] as const)("keeps Chat Completions on %s", (provider) => {
    expect(copilotCliUsesResponsesWire(provider)).toBe(false);
  });

  it("lists the Copilot CLI among the clients with a native session", () => {
    expect(NATIVE_SESSION_CLIENT_LABELS["copilot-cli"]).toBe("Copilot CLI");
  });

  it("offers Copilot CLI only models its Responses setup can reach", () => {
    const serves = (
      provider: Parameters<typeof connectionModelServesClient>[0]["provider"],
      supportedEndpoints: string[] | null,
      clientId = "copilot-cli",
    ) =>
      connectionModelServesClient({ clientId, provider, supportedEndpoints });
    // Claude on GitHub Copilot serves only Chat Completions.
    expect(serves("github-copilot", ["/chat/completions"])).toBe(false);
    expect(serves("github-copilot", ["/responses"])).toBe(true);
    expect(serves("github-copilot", ["/chat/completions", "/responses"])).toBe(
      true,
    );
    // No endpoint list: nothing says the model can't answer.
    expect(serves("github-copilot", null)).toBe(true);
    expect(serves("openai", [])).toBe(true);
    // Chat Completions setups and other clients are not narrowed.
    expect(serves("groq", ["/chat/completions"])).toBe(true);
    expect(serves("github-copilot", ["/chat/completions"], "pi")).toBe(true);
  });
});

describe("connection model defaults", () => {
  it.each([
    [["gpt-5.5", "gpt-6-sol", "gpt-6.1-sol"], "gpt-6.1-sol"],
    [
      ["openai:gpt-5.6-sol", "openai:gpt-6-sol", "openai:gpt-6.1-sol"],
      "openai:gpt-6.1-sol",
    ],
    [["gpt-5.5", "gpt-6-luna"], "gpt-6-luna"],
    [["gpt-5.5", "openai/gpt-6.1-sol"], "openai/gpt-6.1-sol"],
    [["o4-mini", "gpt-5.5"], "o4-mini"],
    [["o4-mini"], "o4-mini"],
    [["gpt-60", "gpt-6.1-sol"], "gpt-6.1-sol"],
    [[], null],
  ])("selects only an available model from %j", (modelIds, expected) => {
    expect(defaultConnectionModel({ provider: "openai", modelIds })).toBe(
      expected,
    );
  });

  it.each([
    [["claude-sonnet-5.5", "gpt-6.1-sol"], "claude-sonnet-5.5"],
    [["gpt-5.3-codex", "gpt-6-sol", "gpt-6.1-terra"], "gpt-6.1-terra"],
    [["gpt-5.3-codex", "gpt-5.6-sol"], "gpt-5.3-codex"],
    [[], null],
  ])("prefers GitHub Copilot's usual model, then the newest GPT line, from %j", (modelIds, expected) => {
    expect(
      defaultConnectionModel({ provider: "github-copilot", modelIds }),
    ).toBe(expected);
  });

  it("does not apply OpenAI family preferences to another provider", () => {
    expect(
      defaultConnectionModel({
        provider: "ollama",
        modelIds: ["local-model", "gpt-6.1-sol"],
      }),
    ).toBe("local-model");
  });
});
