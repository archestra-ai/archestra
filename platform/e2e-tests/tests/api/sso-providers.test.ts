import { API_BASE_URL, UI_BASE_URL } from "../../consts";
import { expect, request as playwrightRequest, test } from "./fixtures";

test.describe("SSO Providers API", () => {
  test("should list SSO providers (authenticated)", async ({
    request,
    createApiKey,
    deleteApiKey,
    makeApiRequest,
  }) => {
    const createResponse = await createApiKey(request);
    const { key: apiKey, id: keyId } = await createResponse.json();

    try {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/sso-providers",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
      });

      expect(response.status()).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    } finally {
      await deleteApiKey(request, keyId);
    }
  });

  test("should list public SSO providers (unauthenticated)", async ({
    request,
    makeApiRequest,
  }) => {
    // This endpoint should work without authentication
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/sso-providers/public",
      headers: {
        "Content-Type": "application/json",
      },
    });

    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);

    // Public endpoint should only return id and providerId
    if (data.length > 0) {
      const provider = data[0];
      expect(provider).toHaveProperty("id");
      expect(provider).toHaveProperty("providerId");
      // Should NOT have sensitive fields
      expect(provider).not.toHaveProperty("oidcConfig");
      expect(provider).not.toHaveProperty("samlConfig");
      expect(provider).not.toHaveProperty("issuer");
      expect(provider).not.toHaveProperty("domain");
    }
  });

  test("should return 404 for non-existent SSO provider", async ({
    request,
    createApiKey,
    deleteApiKey,
    makeApiRequest,
  }) => {
    const createResponse = await createApiKey(request);
    const { key: apiKey, id: keyId } = await createResponse.json();

    try {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/sso-providers/non-existent-id",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        ignoreStatusCheck: true,
      });

      expect(response.status()).toBe(404);
    } finally {
      await deleteApiKey(request, keyId);
    }
  });

  test("should require authentication for full SSO providers list", async () => {
    // Create a fresh request context without any stored authentication
    const unauthenticatedRequest = await playwrightRequest.newContext({
      baseURL: API_BASE_URL,
    });

    try {
      const response = await unauthenticatedRequest.get("/api/sso-providers", {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
      });

      // Should return 401 Unauthorized
      expect(response.status()).toBe(401);
    } finally {
      await unauthenticatedRequest.dispose();
    }
  });

  test("should require authentication for individual SSO provider", async () => {
    // Create a fresh request context without any stored authentication
    const unauthenticatedRequest = await playwrightRequest.newContext({
      baseURL: API_BASE_URL,
    });

    try {
      const response = await unauthenticatedRequest.get(
        "/api/sso-providers/some-id",
        {
          headers: {
            "Content-Type": "application/json",
            Origin: UI_BASE_URL,
          },
        },
      );

      // Should return 401 Unauthorized
      expect(response.status()).toBe(401);
    } finally {
      await unauthenticatedRequest.dispose();
    }
  });
});
