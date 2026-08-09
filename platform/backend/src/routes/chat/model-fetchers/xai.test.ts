import { afterEach, describe, expect, it, vi } from "vitest";
import config from "@/config";
import { encodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import { fetchXaiModels } from "./xai";

const DISCOVERY_PATH = "/.well-known/openid-configuration";
const MODELS_RESPONSE = {
  data: [{ id: "grok-4", created: 1_700_000_000 }, { id: "grok-4-fast" }],
};

/**
 * Routes the three calls a subscription listing makes — OIDC discovery, the
 * token redemption, then the live /models fetch — to their own responses.
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

describe("fetchXaiModels with an X Premium subscription credential", () => {
  it("lists models live under the redeemed bearer", async () => {
    // xAI serves subscription traffic on its ordinary OpenAI-compatible surface,
    // so unlike Codex the catalog is fetched rather than hardcoded.
    const fetchMock = stubXaiFetch();

    const models = await fetchXaiModels(
      encodeXaiSubscriptionCredential({ refreshToken: "rt_secret" }),
    );

    expect(models.map((model) => model.id)).toEqual(["grok-4", "grok-4-fast"]);
    expect(models.every((model) => model.provider === "xai")).toBe(true);

    const modelsCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/models"),
    );
    expect(modelsCall).toBeDefined();
    const init = modelsCall?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    // The stored secret is an encoded credential, never a usable bearer — the
    // redeemed access token is what reaches xAI.
    expect(init?.headers?.Authorization ?? init?.headers?.authorization).toBe(
      "Bearer at_1",
    );
  });

  it("refuses to send the redeemed bearer to a per-key base URL override", async () => {
    // Same fail-closed rule as the proxy fetch wrapper: the override is
    // user-supplied and must never receive the subscription bearer.
    const fetchMock = stubXaiFetch();

    await expect(
      fetchXaiModels(
        encodeXaiSubscriptionCredential({ refreshToken: "rt_secret" }),
        "https://attacker.example/v1",
      ),
    ).rejects.toThrow(/configured xAI API base URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a rejected credential so key creation fails clearly", async () => {
    stubXaiFetch({
      redemption: Response.json({ error: "invalid_grant" }, { status: 400 }),
    });

    await expect(
      fetchXaiModels(
        encodeXaiSubscriptionCredential({ refreshToken: "rt_bad" }),
      ),
    ).rejects.toThrow(/Reconnect your X account/);
  });
});

describe("fetchXaiModels with a plain API key", () => {
  it("sends the key straight through as the bearer", async () => {
    const fetchMock = stubXaiFetch();

    const models = await fetchXaiModels("xai-plain-key");

    expect(models.map((model) => model.id)).toEqual(["grok-4", "grok-4-fast"]);
    // No OAuth hop at all for a metered key.
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(init?.headers?.Authorization ?? init?.headers?.authorization).toBe(
      "Bearer xai-plain-key",
    );
  });
});
