import type { APIRequestContext } from "@playwright/test";
import { API_BASE_URL } from "../../consts";
import { expect, LLM_PROVIDER_API_KEYS_ROUTE, test } from "../api-fixtures";

/**
 * End-to-end verification for the per-virtual-key token-cost budget. Happy
 * path: create a vkey → attach a vkey-scope `token_cost` limit → make several
 * LLM calls → observe the proxy flip from 200 (within budget) to 429
 * (exhausted) with the `token_cost_limit_exceeded` code returned to the caller.
 *
 * This spec deliberately uses a very low `limitValue` (in dollars) so even a
 * single small WireMock-backed request pushes over the limit via the default
 * $30–$50 / M-token fallback pricing.
 */

const TEST_PROVIDER = "openai";

type MakeApiRequest = (args: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  ignoreStatusCheck?: boolean;
}) => Promise<{ json: () => Promise<unknown>; ok: () => boolean }>;

async function createChatApiKey(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
) {
  const uniqueName = `e2e-budget-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: LLM_PROVIDER_API_KEYS_ROUTE,
    data: {
      name: uniqueName,
      provider: TEST_PROVIDER,
      apiKey: "sk-e2e-budget-key-for-wiremock",
      scope: "org",
      baseUrl: null,
    },
  });
  return (await response.json()) as { id: string };
}

async function createVirtualKey(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  chatApiKeyId: string,
) {
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: `/api/llm-virtual-keys/${chatApiKeyId}`,
    data: {
      name: `e2e-budget-vk-${Date.now()}`,
      expiresAt: null,
    },
  });
  return (await response.json()) as { id: string; value: string };
}

async function createVkeyLimit(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  virtualKeyId: string,
) {
  // Very tight $1 cap so a single mocked request exhausts it via the default
  // pricing tier. entity_id is the vkey UUID; organizationId is injected
  // server-side from request.organizationId.
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/limits",
    data: {
      entityType: "virtual_api_key",
      entityId: virtualKeyId,
      limitType: "token_cost",
      limitValue: 1,
      model: ["*"],
    },
  });
  return (await response.json()) as { id: string };
}

async function callProxy(
  request: APIRequestContext,
  proxyId: string,
  virtualKeyValue: string,
) {
  return request.post(`${API_BASE_URL}/v1/openai/${proxyId}/chat/completions`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${virtualKeyValue}`,
    },
    data: {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
  });
}

test.describe.configure({ mode: "serial" });

test.describe("LLM Proxy — Per-virtual-key budget enforcement", () => {
  test("creates a vkey budget and observes the 429 cutover", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(
      request,
      "e2e-budget-vk-proxy",
      "org",
    );
    const proxy = await proxyResp.json();

    const chatApiKey = await createChatApiKey(makeApiRequest, request);
    const vkey = await createVirtualKey(makeApiRequest, request, chatApiKey.id);
    const limit = await createVkeyLimit(makeApiRequest, request, vkey.id);

    try {
      // First call succeeds: the limit row exists but usage is $0.
      const first = await callProxy(request, proxy.id, vkey.value);
      expect(first.ok()).toBeTruthy();

      // Hammer the proxy until the accumulated cost crosses the $1 cap and
      // the enforcement layer flips to 429. Upper bound of attempts keeps
      // the test deterministic; CI pricing fallback guarantees crossover
      // within a handful of calls.
      let sawBlock = false;
      for (let i = 0; i < 20; i++) {
        const resp = await callProxy(request, proxy.id, vkey.value);
        if (resp.status() === 429) {
          const body = await resp.json();
          expect(body.error.code).toBe("token_cost_limit_exceeded");
          sawBlock = true;
          break;
        }
      }
      expect(sawBlock).toBeTruthy();
    } finally {
      // Best-effort cleanup — limit row cascades via vkey deletion.
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/limits/${limit.id}`,
        ignoreStatusCheck: true,
      });
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/llm-virtual-keys/${chatApiKey.id}/${vkey.id}`,
        ignoreStatusCheck: true,
      });
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `${LLM_PROVIDER_API_KEYS_ROUTE}/${chatApiKey.id}`,
        ignoreStatusCheck: true,
      });
      await deleteAgent(request, proxy.id);
    }
  });
});
