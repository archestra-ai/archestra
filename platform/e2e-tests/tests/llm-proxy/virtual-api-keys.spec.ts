import { hasArchestraTokenPrefix } from "@archestra/shared";
import type { APIRequestContext } from "@playwright/test";
import { API_BASE_URL, WIREMOCK_INTERNAL_URL } from "../../consts";
import { expect, LLM_PROVIDER_API_KEYS_ROUTE, test } from "../api-fixtures";

/**
 * E2E test for virtual API keys in the LLM Proxy.
 *
 * Verifies the happy path: a virtual key authenticates a proxy request.
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
  opts?: { provider?: string; baseUrl?: string | null; apiKey?: string },
) {
  const provider = opts?.provider ?? TEST_PROVIDER;
  const uniqueName = `e2e-vk-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: LLM_PROVIDER_API_KEYS_ROUTE,
    data: {
      name: uniqueName,
      provider,
      apiKey: opts?.apiKey ?? "sk-e2e-test-key-for-wiremock",
      scope: "org",
      baseUrl: opts?.baseUrl ?? `${WIREMOCK_INTERNAL_URL}/openai/v1`,
    },
  });
  return (await response.json()) as {
    id: string;
    name: string;
    provider: string;
  };
}

async function createVirtualKey(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  providerApiKey: { id: string; provider: string },
  opts?: { name?: string; expiresAt?: string | null },
) {
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/llm-virtual-keys",
    data: {
      name: opts?.name ?? "test-vk",
      providerApiKeys: [
        {
          provider: providerApiKey.provider,
          providerApiKeyId: providerApiKey.id,
        },
      ],
      ...(opts?.expiresAt !== undefined && { expiresAt: opts.expiresAt }),
    },
  });
  return (await response.json()) as {
    id: string;
    value: string;
    name: string;
    tokenStart: string;
    expiresAt: string | null;
    createdAt: string;
    lastUsedAt: string | null;
  };
}

async function cleanupChatApiKey(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  chatApiKeyId: string,
) {
  await makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/llm-provider-api-keys/${chatApiKeyId}`,
    ignoreStatusCheck: true,
  });
}

async function callProxyWithVirtualKey(
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

test.describe("Virtual API Keys - LLM Proxy", () => {
  test("virtual key authenticates proxy request", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    // Setup: create LLM proxy + chat API key + virtual key
    const proxyResp = await createLlmProxy(request, "e2e-vk-proxy", "personal");
    const proxy = await proxyResp.json();

    const chatApiKey = await createChatApiKey(makeApiRequest, request);

    const vk = await createVirtualKey(makeApiRequest, request, chatApiKey, {
      name: "test-vk",
    });
    expect(hasArchestraTokenPrefix(vk.value)).toBe(true);

    try {
      // Call LLM proxy with the virtual key
      const proxyResponse = await callProxyWithVirtualKey(
        request,
        proxy.id,
        vk.value,
      );

      // WireMock should return 200 (mocked response)
      expect(proxyResponse.ok()).toBeTruthy();
    } finally {
      // Delete the virtual key before the parent — the backend blocks parent
      // chat-key deletion while a mapped virtual key exists, and
      // cleanupChatApiKey swallows that failure, so without this both rows
      // leak.
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/llm-virtual-keys/${vk.id}`,
        ignoreStatusCheck: true,
      });
      await cleanupChatApiKey(makeApiRequest, request, chatApiKey.id);
      await deleteAgent(request, proxy.id);
    }
  });
});
