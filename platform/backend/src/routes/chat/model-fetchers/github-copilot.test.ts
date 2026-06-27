import { vi } from "vitest";
import { fetchGithubCopilotModels } from "@/routes/chat/model-fetchers/github-copilot";
import { afterEach, describe, expect, test } from "@/test";

let tokenCounter = 0;
function uniqueGithubToken(): string {
  tokenCounter += 1;
  return `gho_fetcher_test_${Date.now()}_${tokenCounter}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGithubCopilotModels", () => {
  test("exchanges the GitHub token, then keeps only chat/completions-capable models", async () => {
    // Shapes mirror a real Copilot /models response (verified live): a
    // Responses-only codex model, the Anthropic /v1/messages shim, embeddings
    // and `completion` types, a policy-disabled model, and legacy chat models
    // with no supported_endpoints field.
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url.includes("copilot_internal")) {
        return Promise.resolve(
          Response.json({
            token: "copilot-bearer",
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              // legacy chat model: no supported_endpoints, picker=false → kept
              model_picker_enabled: false,
              capabilities: {
                type: "chat",
                limits: { max_context_window_tokens: 128000 },
                supports: { tool_calls: true },
              },
            },
            {
              id: "claude-sonnet-4",
              // no name → falls back to id
              supported_endpoints: ["/chat/completions"],
              capabilities: { type: "chat", supports: { tool_calls: false } },
            },
            {
              id: "gpt-5.3-codex",
              // Responses-only — must be dropped even though picker=true
              model_picker_enabled: true,
              supported_endpoints: ["/responses"],
              capabilities: { type: "chat" },
            },
            {
              id: "claude-opus-shim",
              // Anthropic /v1/messages shim — dropped
              supported_endpoints: ["/v1/messages"],
              capabilities: { type: "chat" },
            },
            {
              id: "text-embedding-3-small",
              capabilities: { type: "embeddings" },
            },
            {
              id: "gpt-41-copilot",
              capabilities: { type: "completion" },
            },
            {
              id: "o1",
              policy: { state: "disabled" },
              capabilities: { type: "chat" },
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchGithubCopilotModels(uniqueGithubToken());

    expect(models).toEqual([
      {
        id: "gpt-4o",
        displayName: "GPT-4o",
        provider: "github-copilot",
        capabilities: { contextLength: 128000, supportsToolCalling: true },
      },
      {
        id: "claude-sonnet-4",
        displayName: "claude-sonnet-4",
        provider: "github-copilot",
        capabilities: { contextLength: null, supportsToolCalling: false },
      },
    ]);

    const modelsCall = fetchMock.mock.calls.find(
      ([input]) => !String(input).includes("copilot_internal"),
    );
    expect(modelsCall).toBeDefined();
    const headers = modelsCall?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer copilot-bearer");
    expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
  });

  test("surfaces the curated 401 when the token exchange rejects the GitHub token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    );

    await expect(
      fetchGithubCopilotModels(uniqueGithubToken()),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining("Copilot subscription"),
    });
  });

  test("throws with the upstream status when the models call fails", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      if (String(input).includes("copilot_internal")) {
        return Promise.resolve(
          Response.json({
            token: "copilot-bearer",
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          }),
        );
      }
      return Promise.resolve(new Response("nope", { status: 500 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGithubCopilotModels(uniqueGithubToken())).rejects.toThrow(
      "Failed to fetch GitHub Copilot models: 500",
    );
  });
});
