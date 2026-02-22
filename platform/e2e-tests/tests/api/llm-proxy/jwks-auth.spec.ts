/**
 * E2E tests for LLM Proxy authentication via external IdP JWKS.
 *
 * Tests the flow:
 * 1. Create identity provider with OIDC config (Keycloak)
 * 2. Create LLM Proxy profile linked to the IdP
 * 3. Obtain JWT from Keycloak (direct grant)
 * 4. Authenticate to LLM Proxy using the JWT
 * 5. Verify the proxy returns a model response (via WireMock)
 */
import { API_BASE_URL } from "../../../consts";
import { getKeycloakJwt } from "../../../utils";
import { expect, test } from "../fixtures";

test.describe("LLM Proxy - External IdP JWKS Authentication", () => {
  test("should authenticate with external IdP JWT and get model response", async ({
    request,
    deleteAgent,
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

    let proxyId: string | undefined;
    try {
      // STEP 3: Create an LLM Proxy profile with IdP linked directly
      const proxyResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `JWKS LLM Proxy E2E ${Date.now()}`,
          teams: [],
          agentType: "llm_proxy",
          identityProviderId,
        },
      });
      const proxy = (await proxyResponse.json()) as { id: string };
      proxyId = proxy.id;

      // STEP 4: Verify the agent has identityProviderId set
      const agentResp = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/agents/${proxyId}`,
      });
      const agentData = (await agentResp.json()) as {
        identityProviderId: string | null;
      };
      expect(agentData.identityProviderId).toBe(identityProviderId);

      // STEP 5: Call the OpenAI proxy endpoint with the JWT as Bearer token
      const response = await request.post(
        `${API_BASE_URL}/v1/openai/${proxyId}/chat/completions`,
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
      if (proxyId) {
        await deleteAgent(request, proxyId);
      }
      await deleteIdentityProvider(request, identityProviderId);
    }
  });

  test("should reject invalid JWT with 401", async ({
    request,
    deleteAgent,
    createIdentityProvider,
    deleteIdentityProvider,
    makeApiRequest,
  }) => {
    // Create identity provider and LLM Proxy profile
    const providerName = `LlmProxyJwksReject${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
    );

    let proxyId: string | undefined;
    try {
      // Create LLM Proxy with IdP linked directly (avoids separate PUT)
      const proxyResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `JWKS Reject LLM Proxy ${Date.now()}`,
          teams: [],
          agentType: "llm_proxy",
          identityProviderId,
        },
      });
      const proxy = (await proxyResponse.json()) as { id: string };
      proxyId = proxy.id;

      // Call with an invalid JWT
      const response = await request.post(
        `${API_BASE_URL}/v1/openai/${proxyId}/chat/completions`,
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
      if (proxyId) {
        await deleteAgent(request, proxyId);
      }
      await deleteIdentityProvider(request, identityProviderId);
    }
  });

  test("should fall through to provider API key when profile has no IdP", async ({
    request,
    createLlmProxy,
    deleteAgent,
  }) => {
    // Create LLM Proxy profile WITHOUT an IdP linked
    const proxyResponse = await createLlmProxy(
      request,
      `No IdP LLM Proxy ${Date.now()}`,
    );
    const proxy = await proxyResponse.json();
    const proxyId = proxy.id;

    try {
      // Call with a raw provider API key — no IdP means standard auth flow
      const response = await request.post(
        `${API_BASE_URL}/v1/openai/${proxyId}/chat/completions`,
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
    } finally {
      await deleteAgent(request, proxyId);
    }
  });
});
