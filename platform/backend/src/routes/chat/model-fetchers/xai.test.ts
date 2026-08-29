import { afterEach, describe, expect, it, vi } from "vitest";
import config from "@/config";
import { encodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import { fetchXaiModels } from "./xai";

const DISCOVERY_PATH = "/.well-known/openid-configuration";
const MODELS_RESPONSE = {
  data: [
    { id: "grok-4", created: 1_700_000_000 },
    {
      id: "catalog-grok-4-fast",
      model: "grok-4-fast",
      name: "Grok 4 Fast",
      apiBackend: "chat_completions",
    },
    { modelId: "grok-4-mini" },
    { _meta: { model: "grok-4-meta" } },
    { model: "grok-api-base", baseUrl: config.llm.xai.baseUrl },
    { id: "responses-only", model: "grok-response", apiBackend: "responses" },
    { model: "different-proxy", baseUrl: "https://other.grok.test/v1" },
    { model: "grok-hidden", hidden: true },
    { model: "grok-oauth-only", supportedInApi: false },
    { name: "missing an identifier" },
  ],
};

/**
 * Routes the three calls a subscription listing makes — OIDC discovery, token
 * redemption, then the session proxy's live /models fetch — to their own responses.
 */
function stubXaiFetch(options?: { redemption?: Response }) {
  const issuer = config.llm.xai.subscription.issuer;
  const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const href = String(url);
    if (href.includes(DISCOVERY_PATH)) {
      return Response.json({
        device_authorization_endpoint: `${issuer}/oauth2/device/code`,
        token_endpoint: `${issuer}/oauth2/token`,
      });
    }
    if (href.startsWith(`${issuer}/oauth2/token`)) {
      return (
        options?.redemption ??
        Response.json({ access_token: "at_1", expires_in: 3600 })
      );
    }
    return Response.json(MODELS_RESPONSE);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchXaiModels with a SuperGrok subscription credential", () => {
  it("lists models live under the redeemed bearer", async () => {
    const fetchMock = stubXaiFetch();

    const models = await fetchXaiModels(
      encodeXaiSubscriptionCredential({
        refreshToken: "rt_secret",
        userId: "x-user-123",
        email: "x@example.com",
      }),
    );

    expect(models.map((model) => model.id)).toEqual([
      "grok-4",
      "grok-4-fast",
      "grok-4-mini",
      "grok-4-meta",
      // The subscription CLI proxy serves `responses`-backed models over chat
      // completions, so they list under a subscription credential.
      "grok-response",
      "grok-oauth-only",
    ]);
    expect(models[1].displayName).toBe("Grok 4 Fast");
    expect(models.every((model) => model.provider === "xai")).toBe(true);
    expect(
      models.every((model) =>
        model.capabilities?.supportedEndpoints?.includes("/chat/completions"),
      ),
    ).toBe(true);

    const modelsCall = fetchMock.mock.calls.find(
      ([url]) =>
        String(url) === `${config.llm.xai.subscription.baseUrl}/models`,
    );
    expect(modelsCall).toBeDefined();
    const init = modelsCall?.[1] as
      | { headers?: Record<string, string>; redirect?: RequestRedirect }
      | undefined;
    // The stored secret is an encoded credential, never a usable bearer — the
    // redeemed access token is what reaches xAI.
    expect(init?.headers?.Authorization ?? init?.headers?.authorization).toBe(
      "Bearer at_1",
    );
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-userid": "x-user-123",
        "x-email": "x@example.com",
        "x-grok-client-identifier": "archestra",
        "x-grok-client-mode": "headless",
      }),
    );
    expect(init?.redirect).toBe("manual");
  });

  it("lists a lone responses-backed model like the live SuperGrok catalog", async () => {
    // Regression: xAI's subscription proxy now returns only grok-4.5 with
    // snake_case `api_backend: "responses"` and no baseUrl. The old
    // chat_completions-only filter dropped it, so key creation failed with
    // "Models list is empty".
    const issuer = config.llm.xai.subscription.issuer;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes(DISCOVERY_PATH)) {
          return Response.json({
            device_authorization_endpoint: `${issuer}/oauth2/device/code`,
            token_endpoint: `${issuer}/oauth2/token`,
          });
        }
        if (href.startsWith(`${issuer}/oauth2/token`)) {
          return Response.json({ access_token: "at_1", expires_in: 3600 });
        }
        return Response.json({
          object: "list",
          data: [
            {
              id: "grok-4.5",
              object: "model",
              model: "grok-4.5",
              name: "Grok 4.5",
              api_backend: "responses",
            },
          ],
        });
      }),
    );

    const models = await fetchXaiModels(
      encodeXaiSubscriptionCredential({
        refreshToken: "rt_secret",
        userId: "x-user-123",
      }),
    );

    expect(models.map((model) => model.id)).toEqual(["grok-4.5"]);
    expect(models[0].displayName).toBe("Grok 4.5");
    expect(
      models[0].capabilities?.supportedEndpoints?.includes("/chat/completions"),
    ).toBe(true);
  });

  it("refuses to send the redeemed bearer to a per-key base URL override", async () => {
    // Same fail-closed rule as the proxy fetch wrapper: the override is
    // user-supplied and must never receive the subscription bearer.
    const fetchMock = stubXaiFetch();

    await expect(
      fetchXaiModels(
        encodeXaiSubscriptionCredential({
          refreshToken: "rt_secret",
          userId: "x-user-123",
        }),
        "https://attacker.example/v1",
      ),
    ).rejects.toThrow(/per-key base URL override/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a rejected credential so key creation fails clearly", async () => {
    stubXaiFetch({
      redemption: Response.json({ error: "invalid_grant" }, { status: 400 }),
    });

    await expect(
      fetchXaiModels(
        encodeXaiSubscriptionCredential({
          refreshToken: "rt_bad",
          userId: "x-user-123",
        }),
      ),
    ).rejects.toThrow(/Reconnect your Grok account/);
  });

  it.each([
    ["a malformed xAI marker", "xai-subscription:not-base64"],
    ["another provider marker", "chatgpt-oauth:encoded-refresh-token"],
  ])("rejects %s before any fetch", async (_label, credential) => {
    const fetchMock = stubXaiFetch();

    await expect(
      fetchXaiModels(credential, "https://attacker.example/v1"),
    ).rejects.toThrow(/Reconnect|reconnect/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchXaiModels with a plain API key", () => {
  it("sends the key straight through as the bearer", async () => {
    const fetchMock = stubXaiFetch();

    const models = await fetchXaiModels("xai-plain-key");

    expect(models.map((model) => model.id)).toEqual([
      "grok-4",
      "grok-4-fast",
      "grok-4-mini",
      "grok-4-meta",
      "grok-api-base",
    ]);
    // No OAuth hop at all for a metered key.
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(init?.headers?.Authorization ?? init?.headers?.authorization).toBe(
      "Bearer xai-plain-key",
    );
  });

  it("keeps models targeted at the effective custom API-key endpoint", async () => {
    const customBaseUrl = "https://xai-gateway.example/v1";
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            model: "grok-custom",
            baseUrl: customBaseUrl,
            apiBackend: "chat_completions",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchXaiModels("xai-plain-key", customBaseUrl);

    expect(models.map((model) => model.id)).toEqual(["grok-custom"]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${customBaseUrl}/models`,
      expect.any(Object),
    );
  });
});
