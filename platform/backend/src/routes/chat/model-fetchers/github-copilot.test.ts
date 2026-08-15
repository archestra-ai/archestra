import { vi } from "vitest";
import { fetchGithubCopilotModels } from "@/routes/chat/model-fetchers/github-copilot";
import { afterEach, describe, expect, test } from "@/test";
import { GithubCopilot } from "@/types";

let tokenCounter = 0;
function uniqueGithubToken(): string {
  tokenCounter += 1;
  return `gho_fetcher_test_${Date.now()}_${tokenCounter}`;
}

/** What a live model answers the zero-inference invocability probe. */
function aliveProbeResponse() {
  return Response.json(
    { error: { message: "messages must be non-empty", code: "" } },
    { status: 400 },
  );
}

/** The same, as the Responses endpoint phrases it (the probe omits `input`). */
function aliveResponsesProbeResponse() {
  return Response.json(
    {
      error: { message: "Missing required parameter: 'input'.", code: "" },
    },
    { status: 400 },
  );
}

/** What a dead-but-catalogued model answers any chat/completions request. */
function modelNotSupportedResponse() {
  return Response.json(
    {
      error: {
        message: GithubCopilot.API.MODEL_NOT_SUPPORTED_MESSAGE,
        code: GithubCopilot.API.MODEL_NOT_SUPPORTED_CODE,
        param: "model",
        type: "invalid_request_error",
      },
    },
    { status: 400 },
  );
}

function tokenExchangeResponse() {
  return Response.json({
    token: "copilot-bearer",
    expires_at: Math.floor(Date.now() / 1000) + 1800,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGithubCopilotModels", () => {
  test("exchanges the GitHub token, then keeps every model either proxy surface can serve", async () => {
    // Shapes mirror a real Copilot /models response (verified live): a
    // Responses-only codex model, the Anthropic /v1/messages shim, embeddings
    // and `completion` types, a policy-disabled model, and legacy chat models
    // with no supported_endpoints field.
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url.includes("copilot_internal")) {
        return Promise.resolve(tokenExchangeResponse());
      }
      if (url.endsWith("/chat/completions")) {
        return Promise.resolve(aliveProbeResponse());
      }
      if (url.endsWith("/responses")) {
        return Promise.resolve(aliveResponsesProbeResponse());
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
              // Responses-only — kept, and tagged so it is routed there
              model_picker_enabled: true,
              supported_endpoints: ["/responses"],
              capabilities: { type: "chat" },
            },
            {
              id: "gpt-5.1",
              // Serves both — preferred over chat completions
              supported_endpoints: ["/chat/completions", "/responses"],
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
        capabilities: {
          contextLength: 128000,
          supportsToolCalling: true,
          supportedEndpoints: ["/chat/completions"],
        },
      },
      {
        id: "claude-sonnet-4",
        displayName: "claude-sonnet-4",
        provider: "github-copilot",
        capabilities: {
          contextLength: null,
          supportsToolCalling: false,
          supportedEndpoints: ["/chat/completions"],
        },
      },
      {
        id: "gpt-5.3-codex",
        displayName: "gpt-5.3-codex",
        provider: "github-copilot",
        capabilities: {
          contextLength: null,
          supportsToolCalling: null,
          supportedEndpoints: ["/responses"],
        },
      },
      {
        id: "gpt-5.1",
        displayName: "gpt-5.1",
        provider: "github-copilot",
        capabilities: {
          contextLength: null,
          supportsToolCalling: null,
          supportedEndpoints: ["/chat/completions", "/responses"],
        },
      },
    ]);

    const modelsCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/models"),
    );
    expect(modelsCall).toBeDefined();
    const headers = modelsCall?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer copilot-bearer");
    expect(headers.get("copilot-integration-id")).toBe("vscode-chat");

    // Each candidate is probed on the surface it declares — probing a
    // Responses-only model on chat completions would read as
    // model_not_supported and drop every GPT-5.x model. A model serving both
    // is probed on chat completions, the surface it will be served over.
    const probesByEndpoint = (suffix: string) =>
      fetchMock.mock.calls
        .filter(([input]) => String(input).endsWith(suffix))
        .map(([, init]) => JSON.parse(String(init?.body)).model)
        .sort();
    expect(probesByEndpoint("/chat/completions")).toEqual([
      "claude-sonnet-4",
      "gpt-4o",
      "gpt-5.1",
    ]);
    expect(probesByEndpoint("/responses")).toEqual(["gpt-5.3-codex"]);
  });

  test("probes a Responses-only model without an `input`, so nothing is generated", async () => {
    // An empty `input: []` is a *valid* Responses request and would invoke the
    // model, burning a premium request per model per sync. Omitting `input`
    // entirely is rejected before any inference happens.
    let probeBody: unknown;
    const fetchMock = vi
      .fn()
      .mockImplementation((input: string | URL, init) => {
        const url = String(input);
        if (url.includes("copilot_internal")) {
          return Promise.resolve(tokenExchangeResponse());
        }
        if (url.endsWith("/responses")) {
          probeBody = JSON.parse(String(init?.body));
          return Promise.resolve(aliveResponsesProbeResponse());
        }
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: "gpt-5.5",
                supported_endpoints: ["/responses"],
                capabilities: { type: "chat" },
              },
            ],
          }),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchGithubCopilotModels(uniqueGithubToken());

    expect(models.map((model) => model.id)).toEqual(["gpt-5.5"]);
    expect(probeBody).toEqual({ model: "gpt-5.5" });
  });

  test("drops a Responses-only model the responses endpoint rejects as not supported", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((input: string | URL, init) => {
        const url = String(input);
        if (url.includes("copilot_internal")) {
          return Promise.resolve(tokenExchangeResponse());
        }
        if (url.endsWith("/responses")) {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          return Promise.resolve(
            body.model === "retired-codex"
              ? modelNotSupportedResponse()
              : aliveResponsesProbeResponse(),
          );
        }
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: "gpt-5.5",
                supported_endpoints: ["/responses"],
                capabilities: { type: "chat" },
              },
              {
                id: "retired-codex",
                supported_endpoints: ["/responses"],
                capabilities: { type: "chat" },
              },
            ],
          }),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchGithubCopilotModels(uniqueGithubToken());

    expect(models.map((model) => model.id)).toEqual(["gpt-5.5"]);
  });

  test("drops a catalogued model that chat/completions rejects as not supported (T-959)", async () => {
    // Mirrors the live catalog: `gpt-4` is listed by /models with the same
    // field shape as working models (chat type, no supported_endpoints, no
    // policy), but chat/completions rejects it with `model_not_supported`.
    let probeBody: unknown;
    const fetchMock = vi
      .fn()
      .mockImplementation((input: string | URL, init) => {
        const url = String(input);
        if (url.includes("copilot_internal")) {
          return Promise.resolve(tokenExchangeResponse());
        }
        if (url.endsWith("/chat/completions")) {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          if (body.model === "gpt-4") {
            probeBody = body;
            return Promise.resolve(modelNotSupportedResponse());
          }
          return Promise.resolve(aliveProbeResponse());
        }
        return Promise.resolve(
          Response.json({
            data: [
              { id: "gpt-4o", name: "GPT-4o", capabilities: { type: "chat" } },
              { id: "gpt-4", name: "GPT 4", capabilities: { type: "chat" } },
            ],
          }),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchGithubCopilotModels(uniqueGithubToken());

    expect(models.map((model) => model.id)).toEqual(["gpt-4o"]);
    // The probe is deliberately invalid (empty messages) so nothing is ever
    // generated: the model is validated before the payload.
    expect(probeBody).toEqual({ model: "gpt-4", messages: [] });
  });

  test("keeps a model when the invocability probe is inconclusive", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((input: string | URL, init) => {
        const url = String(input);
        if (url.includes("copilot_internal")) {
          return Promise.resolve(tokenExchangeResponse());
        }
        if (url.endsWith("/chat/completions")) {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          if (body.model === "rate-limited-model") {
            return Promise.resolve(
              Response.json(
                { error: { message: "rate limited", code: "rate_limit" } },
                { status: 429 },
              ),
            );
          }
          if (body.model === "unreachable-model") {
            return Promise.reject(new Error("socket hang up"));
          }
          return Promise.resolve(aliveProbeResponse());
        }
        return Promise.resolve(
          Response.json({
            data: [
              { id: "gpt-4o", capabilities: { type: "chat" } },
              { id: "rate-limited-model", capabilities: { type: "chat" } },
              { id: "unreachable-model", capabilities: { type: "chat" } },
            ],
          }),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchGithubCopilotModels(uniqueGithubToken());

    // Only a definite model_not_supported drops a model — an outage must not
    // empty the catalog.
    expect(models.map((model) => model.id).sort()).toEqual([
      "gpt-4o",
      "rate-limited-model",
      "unreachable-model",
    ]);
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
