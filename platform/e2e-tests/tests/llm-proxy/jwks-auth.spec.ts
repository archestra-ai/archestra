/**
 * E2E tests for LLM Proxy authentication via external IdP JWKS.
 *
 * The LLM Proxy is an organization-wide singleton (GET /api/llm-proxy,
 * created on first use). JWT (JWKS) authentication is configured by binding
 * an identity provider to it via PATCH /api/llm-proxy — there is no
 * per-proxy IdP config anymore.
 *
 * Tests the flow:
 * 1. Create identity provider with OIDC config (Keycloak)
 * 2. Bind it to the LLM Proxy (PATCH /api/llm-proxy)
 * 3. Obtain JWT from Keycloak (direct grant)
 * 4. Authenticate to the LLM Proxy using the JWT
 * 5. Verify the proxy returns a model response (via WireMock)
 *
 * IMPORTANT: the IdP binding is org-wide shared state, so every test that
 * sets it resets identityProviderId to null in its finally block. Specs in
 * other files are unaffected even mid-test: bearer tokens that are not
 * JWT-shaped (raw provider API keys) skip JWKS auth entirely
 * (attemptJwksAuth's isJwtLike gate).
 */
import { API_BASE_URL } from "../../consts";
import { getKeycloakJwt } from "../../utils";
import { expect, test } from "../api-fixtures";

// The suite is fullyParallel, but these tests mutate the singleton proxy's
// IdP binding — keep them ordered in one worker so the no-IdP test cannot
// observe a sibling's binding.
test.describe.configure({ mode: "default" });

test.describe("LLM Proxy - External IdP JWKS Authentication", () => {
  test("should authenticate with external IdP JWT and get model response", async ({
    request,
    createIdentityProvider,
    deleteIdentityProvider,
    makeApiRequest,
  }) => {
    test.slow();

    // STEP 1: Get a test JWT from Keycloak
    const jwt = await getKeycloakJwt();
    expect(jwt).toBeTruthy();
    expect(jwt.split(".")).toHaveLength(3);

    // STEP 2: Create identity provider with Keycloak OIDC config
    const providerName = `LlmProxyJwks${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
    );

    try {
      // STEP 3: Bind the IdP to the org's singleton LLM Proxy
      const patchResponse = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/llm-proxy",
        data: { identityProviderId },
      });
      const proxy = (await patchResponse.json()) as {
        id: string;
        identityProviderId: string | null;
      };
      expect(proxy.identityProviderId).toBe(identityProviderId);

      // STEP 4: Call the id-less OpenAI proxy endpoint with the JWT as Bearer
      const response = await request.post(
        `${API_BASE_URL}/v1/openai/chat/completions`,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          data: {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
          },
        },
      );

      // Read the body FIRST so we can include it in the assertion error message
      const body = await response.json();
      expect(
        response.status(),
        `Expected 200 but got ${response.status()}. Response body: ${JSON.stringify(body)}`,
      ).toBe(200);
      expect(body.choices).toBeDefined();
      expect(body.choices.length).toBeGreaterThan(0);
    } finally {
      // The singleton proxy is shared state — unbind the IdP for other specs.
      await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/llm-proxy",
        data: { identityProviderId: null },
      });
      await deleteIdentityProvider(request, identityProviderId);
    }
  });

  test("should reject invalid JWT with 401", async ({
    request,
    createIdentityProvider,
    deleteIdentityProvider,
    makeApiRequest,
  }) => {
    // Create an identity provider and bind it to the singleton LLM Proxy
    const providerName = `LlmProxyJwksReject${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
    );

    try {
      await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/llm-proxy",
        data: { identityProviderId },
      });

      // Call with an invalid (but JWT-shaped) token
      const response = await request.post(
        `${API_BASE_URL}/v1/openai/chat/completions`,
        {
          headers: {
            Authorization: "Bearer invalid.jwt.token",
            "Content-Type": "application/json",
          },
          data: {
            model: "gpt-4",
            messages: [{ role: "user", content: "Hello" }],
          },
        },
      );

      // Read the body FIRST so we can include it in the assertion error message
      const body = await response.json();
      expect(
        response.status(),
        `Expected 401 but got ${response.status()}. Response body: ${JSON.stringify(body)}`,
      ).toBe(401);
    } finally {
      await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/llm-proxy",
        data: { identityProviderId: null },
      });
      await deleteIdentityProvider(request, identityProviderId);
    }
  });

  test("should fall through to provider API key when no IdP is bound", async ({
    request,
    getLlmProxy,
  }) => {
    // The preceding tests reset the binding in their finally blocks, so the
    // singleton has no IdP here. Its id in the URL exercises the
    // legacy-style per-proxy path, which collapses to the singleton.
    const proxyResponse = await getLlmProxy(request);
    const proxy = (await proxyResponse.json()) as {
      id: string;
      identityProviderId: string | null;
    };
    expect(proxy.identityProviderId).toBeNull();

    // Call with a raw provider API key — no IdP means standard auth flow
    const response = await request.post(
      `${API_BASE_URL}/v1/openai/${proxy.id}/chat/completions`,
      {
        headers: {
          Authorization: "Bearer openai-jwks-fallback-test",
          "Content-Type": "application/json",
        },
        data: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        },
      },
    );

    // WireMock accepts any API key and returns a mocked response
    const body = await response.json();
    expect(
      response.status(),
      `Expected 200 but got ${response.status()}. Response body: ${JSON.stringify(body)}`,
    ).toBe(200);
    expect(body.choices).toBeDefined();
  });
});
