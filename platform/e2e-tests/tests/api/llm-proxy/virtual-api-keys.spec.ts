import type { APIRequestContext } from "@playwright/test";
import { API_BASE_URL, WIREMOCK_BASE_URL } from "../../../consts";
import { expect, test } from "../fixtures";

/**
 * E2E tests for virtual API keys in the LLM Proxy.
 *
 * These tests verify that:
 * 1. Virtual API keys can authenticate proxy requests
 * 2. Virtual keys resolve to the correct provider API key
 * 3. Expired virtual keys are rejected
 * 4. Provider mismatches are rejected
 * 5. Invalid virtual keys are rejected
 * 6. Raw provider keys still work (backward compat)
 */

const TEST_PROVIDER = "openai";
const TEST_API_KEY_NAME = "e2e-virtual-key-test";

/**
 * Helper: create a chat API key and return its ID
 */
async function createChatApiKey(
  makeApiRequest: (args: {
    request: APIRequestContext;
    method: "get" | "post" | "put" | "patch" | "delete";
    urlSuffix: string;
    data?: unknown;
    ignoreStatusCheck?: boolean;
  }) => Promise<{ json: () => Promise<unknown>; ok: () => boolean }>,
  request: APIRequestContext,
  opts?: { provider?: string; baseUrl?: string },
) {
  const provider = opts?.provider ?? TEST_PROVIDER;
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/chat-api-keys",
    data: {
      name: TEST_API_KEY_NAME,
      provider,
      apiKey: "sk-e2e-test-key-for-wiremock",
      scope: "org_wide",
      baseUrl: opts?.baseUrl ?? null,
    },
  });
  return (await response.json()) as { id: string; provider: string };
}

/**
 * Helper: cleanup chat API key by name
 */
async function cleanupChatApiKey(
  makeApiRequest: (args: {
    request: APIRequestContext;
    method: "get" | "post" | "put" | "patch" | "delete";
    urlSuffix: string;
    data?: unknown;
    ignoreStatusCheck?: boolean;
  }) => Promise<{ json: () => Promise<unknown>; ok: () => boolean }>,
  request: APIRequestContext,
) {
  const keysResp = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/chat-api-keys",
  });
  const keys = (await keysResp.json()) as { id: string; name: string }[];
  for (const key of keys) {
    if (key.name === TEST_API_KEY_NAME) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/chat-api-keys/${key.id}`,
        ignoreStatusCheck: true,
      });
    }
  }
}

test.describe("Virtual API Keys - LLM Proxy", () => {
  test("virtual key authenticates proxy request", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    // Setup: create LLM proxy + chat API key + virtual key
    const proxyResp = await createLlmProxy(request, "e2e-vk-proxy");
    const proxy = await proxyResp.json();

    await cleanupChatApiKey(makeApiRequest, request);
    const chatApiKey = await createChatApiKey(makeApiRequest, request);

    const vkResp = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}/virtual-keys`,
      data: { name: "test-vk" },
    });
    const vk = (await vkResp.json()) as { id: string; value: string };
    expect(vk.value).toMatch(/^archestra_/);

    try {
      // Call LLM proxy with the virtual key
      const proxyResponse = await request.post(
        `${API_BASE_URL}/v1/openai/${proxy.id}/chat/completions`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${vk.value}`,
          },
          data: {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "Say hello" }],
            stream: false,
          },
        },
      );

      // WireMock should return 200 (mocked response)
      expect(proxyResponse.ok()).toBeTruthy();
    } finally {
      await cleanupChatApiKey(makeApiRequest, request);
      await deleteAgent(request, proxy.id);
    }
  });

  test("expired virtual key returns 401", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(request, "e2e-vk-expired");
    const proxy = await proxyResp.json();

    await cleanupChatApiKey(makeApiRequest, request);
    const chatApiKey = await createChatApiKey(makeApiRequest, request);

    // Create a virtual key that expires in 1 second, then wait for it to expire
    const vkResp = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}/virtual-keys`,
      data: {
        name: "expired-vk",
        expiresAt: new Date(Date.now() + 1000).toISOString(), // 1s from now
      },
    });
    const vk = (await vkResp.json()) as { id: string; value: string };

    // Wait for the key to expire
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const proxyResponse = await request.post(
        `${API_BASE_URL}/v1/openai/${proxy.id}/chat/completions`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${vk.value}`,
          },
          data: {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          },
        },
      );

      expect(proxyResponse.status()).toBe(401);
      const body = await proxyResponse.json();
      expect(body.error.message).toContain("expired");
    } finally {
      await cleanupChatApiKey(makeApiRequest, request);
      await deleteAgent(request, proxy.id);
    }
  });

  test("virtual key for wrong provider returns 400", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(request, "e2e-vk-wrong-provider");
    const proxy = await proxyResp.json();

    await cleanupChatApiKey(makeApiRequest, request);
    // Create an OpenAI key but call the Anthropic proxy
    const chatApiKey = await createChatApiKey(makeApiRequest, request, {
      provider: "openai",
    });

    const vkResp = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}/virtual-keys`,
      data: { name: "wrong-provider-vk" },
    });
    const vk = (await vkResp.json()) as { id: string; value: string };

    try {
      const proxyResponse = await request.post(
        `${API_BASE_URL}/v1/anthropic/${proxy.id}/v1/messages`,
        {
          headers: {
            "Content-Type": "application/json",
            "x-api-key": vk.value,
          },
          data: {
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 10,
            messages: [{ role: "user", content: "hello" }],
          },
        },
      );

      expect(proxyResponse.status()).toBe(400);
      const body = await proxyResponse.json();
      expect(body.error.message).toContain("openai");
    } finally {
      await cleanupChatApiKey(makeApiRequest, request);
      await deleteAgent(request, proxy.id);
    }
  });

  test("invalid virtual key returns 401", async ({
    request,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(request, "e2e-vk-invalid");
    const proxy = await proxyResp.json();

    try {
      const proxyResponse = await request.post(
        `${API_BASE_URL}/v1/openai/${proxy.id}/chat/completions`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer archestra_invalidtoken1234",
          },
          data: {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          },
        },
      );

      expect(proxyResponse.status()).toBe(401);
      const body = await proxyResponse.json();
      expect(body.error.message).toContain("Invalid virtual API key");
    } finally {
      await deleteAgent(request, proxy.id);
    }
  });

  test("raw provider key still works (backward compat)", async ({
    request,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(request, "e2e-vk-raw-key");
    const proxy = await proxyResp.json();

    try {
      const proxyResponse = await request.post(
        `${API_BASE_URL}/v1/openai/${proxy.id}/chat/completions`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer sk-test-raw-key",
          },
          data: {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hello" }],
            stream: false,
          },
        },
      );

      // WireMock should return 200 (mocked response)
      expect(proxyResponse.ok()).toBeTruthy();
    } finally {
      await deleteAgent(request, proxy.id);
    }
  });
});
