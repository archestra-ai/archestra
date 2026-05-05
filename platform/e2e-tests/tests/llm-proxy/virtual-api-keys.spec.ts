import type { APIRequestContext } from "@playwright/test";
import { hasArchestraTokenPrefix } from "@shared";
import { API_BASE_URL, WIREMOCK_INTERNAL_URL } from "../../consts";
import { expect, LLM_PROVIDER_API_KEYS_ROUTE, test } from "../api-fixtures";

/**
 * E2E tests for virtual API keys in the LLM Proxy.
 *
 * These tests verify:
 * - CRUD operations on the virtual API keys management API
 * - Proxy authentication with virtual keys (happy path, expiration, provider mismatch, etc.)
 * - Cascading invalidation when parent keys or virtual keys are deleted
 * - Per-key base URL routing
 * - Backward compatibility with raw provider keys
 */

const TEST_PROVIDER = "openai";

// =========================================================================
// Helpers
// =========================================================================

type MakeApiRequest = (args: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  ignoreStatusCheck?: boolean;
}) => Promise<{ json: () => Promise<unknown>; ok: () => boolean }>;

/**
 * Helper: create a chat API key with a unique name and return its ID.
 * Uses a unique name per call to avoid race conditions with parallel test workers.
 */
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

/**
 * Helper: create a virtual key for a chat API key.
 */
async function createVirtualKey(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  chatApiKeyId: string,
  opts?: { name?: string; expiresAt?: string | null },
) {
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/llm-virtual-keys",
    data: {
      name: opts?.name ?? "test-vk",
      chatApiKeyId,
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

/**
 * Helper: cleanup chat API key by ID
 */
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

/**
 * Helper: make a proxy request with a virtual key and return the response.
 */
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

// =========================================================================
// LLM Proxy Authentication Tests
// =========================================================================

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

    const vk = await createVirtualKey(makeApiRequest, request, chatApiKey.id, {
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
      await cleanupChatApiKey(makeApiRequest, request, chatApiKey.id);
      await deleteAgent(request, proxy.id);
    }
  });

  test("expired virtual key returns 401", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(
      request,
      "e2e-vk-expired",
      "personal",
    );
    const proxy = await proxyResp.json();

    const chatApiKey = await createChatApiKey(makeApiRequest, request);

    // Create a virtual key that expires in 5 seconds, then wait for it to expire.
    // Use generous margins to avoid flakiness from clock skew or CI slowness.
    // NOTE: This test may fail locally if the server timezone differs from UTC
    // because the virtual_api_keys.expires_at column is `timestamp without time zone`
    // despite the schema declaring `withTimezone: true`. In CI (UTC), this works correctly.
    const vk = await createVirtualKey(makeApiRequest, request, chatApiKey.id, {
      name: "expired-vk",
      expiresAt: new Date(Date.now() + 5000).toISOString(), // 5s from now
    });

    // Wait for the key to expire (10s wait gives 5s margin over the 5s TTL)
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    try {
      const proxyResponse = await callProxyWithVirtualKey(
        request,
        proxy.id,
        vk.value,
      );

      expect(proxyResponse.status()).toBe(401);
      const body = await proxyResponse.json();
      expect(body.error.message).toContain("expired");
    } finally {
      await cleanupChatApiKey(makeApiRequest, request, chatApiKey.id);
      await deleteAgent(request, proxy.id);
    }
  });

  test("virtual key for wrong provider returns 400", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(
      request,
      "e2e-vk-wrong-provider",
      "personal",
    );
    const proxy = await proxyResp.json();

    // Create an OpenAI key but call the Anthropic proxy
    const chatApiKey = await createChatApiKey(makeApiRequest, request, {
      provider: "openai",
    });

    const vk = await createVirtualKey(makeApiRequest, request, chatApiKey.id, {
      name: "wrong-provider-vk",
    });

    try {
      const proxyResponse = await request.post(
        `${API_BASE_URL}/v1/anthropic/${proxy.id}/v1/messages`,
        {
          headers: {
            "Content-Type": "application/json",
            "x-api-key": vk.value,
            "anthropic-version": "2023-06-01",
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
      await cleanupChatApiKey(makeApiRequest, request, chatApiKey.id);
      await deleteAgent(request, proxy.id);
    }
  });

  test("invalid virtual key returns 401", async ({
    request,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(
      request,
      "e2e-vk-invalid",
      "personal",
    );
    const proxy = await proxyResp.json();

    try {
      const proxyResponse = await callProxyWithVirtualKey(
        request,
        proxy.id,
        "archestra_invalidtoken1234",
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
    const proxyResp = await createLlmProxy(
      request,
      "e2e-vk-raw-key",
      "personal",
    );
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

  test("virtual key without expiration works indefinitely", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(
      request,
      "e2e-vk-no-expiry",
      "personal",
    );
    const proxy = await proxyResp.json();

    const chatApiKey = await createChatApiKey(makeApiRequest, request);

    // Create a virtual key with no expiration
    const vk = await createVirtualKey(makeApiRequest, request, chatApiKey.id, {
      name: "no-expiry-vk",
      expiresAt: null,
    });

    expect(vk.expiresAt).toBeNull();

    try {
      const proxyResponse = await callProxyWithVirtualKey(
        request,
        proxy.id,
        vk.value,
      );
      expect(proxyResponse.ok()).toBeTruthy();
    } finally {
      await cleanupChatApiKey(makeApiRequest, request, chatApiKey.id);
      await deleteAgent(request, proxy.id);
    }
  });

  test("deleted virtual key returns 401 on proxy", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(
      request,
      "e2e-vk-deleted",
      "personal",
    );
    const proxy = await proxyResp.json();

    const chatApiKey = await createChatApiKey(makeApiRequest, request);
    const vk = await createVirtualKey(makeApiRequest, request, chatApiKey.id);

    // Verify it works first
    const okResp = await callProxyWithVirtualKey(request, proxy.id, vk.value);
    expect(okResp.ok()).toBeTruthy();

    // Delete the virtual key
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/llm-virtual-keys/${vk.id}`,
    });

    try {
      // Now the same token should be rejected
      const failResp = await callProxyWithVirtualKey(
        request,
        proxy.id,
        vk.value,
      );
      expect(failResp.status()).toBe(401);
      const body = await failResp.json();
      expect(body.error.message).toContain("Invalid virtual API key");
    } finally {
      await cleanupChatApiKey(makeApiRequest, request, chatApiKey.id);
      await deleteAgent(request, proxy.id);
    }
  });

  test("deleted parent chat API key invalidates virtual key", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    const proxyResp = await createLlmProxy(
      request,
      "e2e-vk-parent-deleted",
      "personal",
    );
    const proxy = await proxyResp.json();

    const chatApiKey = await createChatApiKey(makeApiRequest, request);
    const vk = await createVirtualKey(makeApiRequest, request, chatApiKey.id);

    // Verify it works first
    const okResp = await callProxyWithVirtualKey(request, proxy.id, vk.value);
    expect(okResp.ok()).toBeTruthy();

    // Delete the PARENT chat API key (cascade should delete virtual keys)
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/llm-provider-api-keys/${chatApiKey.id}`,
    });

    try {
      // Virtual key should now be invalid
      const failResp = await callProxyWithVirtualKey(
        request,
        proxy.id,
        vk.value,
      );
      expect(failResp.status()).toBe(401);
    } finally {
      await deleteAgent(request, proxy.id);
    }
  });

  test("virtual key with per-key base URL routes to custom endpoint", async ({
    request,
    makeApiRequest,
    createLlmProxy,
    deleteAgent,
  }) => {
    // Uses the static WireMock mapping at /custom-base-url-test/v1/chat/completions
    // which returns a distinct response ID ("chatcmpl-custom-base-url")
    const proxyResp = await createLlmProxy(
      request,
      "e2e-vk-custom-base",
      "personal",
    );
    const proxy = await proxyResp.json();

    // Create a chat API key with a custom base URL pointing to the static WireMock mapping path
    const chatApiKey = await createChatApiKey(makeApiRequest, request, {
      baseUrl: `${WIREMOCK_INTERNAL_URL}/custom-base-url-test/v1`,
    });
    const vk = await createVirtualKey(makeApiRequest, request, chatApiKey.id);

    try {
      const proxyResponse = await callProxyWithVirtualKey(
        request,
        proxy.id,
        vk.value,
      );
      expect(proxyResponse.ok()).toBeTruthy();

      // The distinct response ID proves the request was routed to the custom base URL
      // (the default WireMock mapping returns "chatcmpl-virtual-api-key-e2e" instead)
      const body = await proxyResponse.json();
      expect(body.id).toBe("chatcmpl-custom-base-url");
    } finally {
      await cleanupChatApiKey(makeApiRequest, request, chatApiKey.id);
      await deleteAgent(request, proxy.id);
    }
  });
});
