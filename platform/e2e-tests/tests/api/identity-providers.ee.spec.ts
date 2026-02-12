import { API_BASE_URL, UI_BASE_URL } from "../../consts";
import { expect, test } from "./fixtures";

test.describe("Identity Providers API", () => {
  test("should list identity providers (authenticated)", async ({
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
        urlSuffix: "/api/identity-providers",
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

  test("should list public identity providers (unauthenticated)", async ({
    request,
    makeApiRequest,
  }) => {
    // This endpoint should work without authentication
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/identity-providers/public",
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

  test("should return 404 for non-existent identity provider", async ({
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
        urlSuffix: "/api/identity-providers/non-existent-id",
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

  test("should require authentication for full identity providers list", async () => {
    // Use native fetch to ensure completely unauthenticated request
    const response = await fetch(`${API_BASE_URL}/api/identity-providers`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Origin: UI_BASE_URL,
      },
    });

    // Should return 401 Unauthorized
    expect(response.status).toBe(401);
  });

  test("should require authentication for individual identity provider", async () => {
    // Use native fetch to ensure completely unauthenticated request
    const response = await fetch(
      `${API_BASE_URL}/api/identity-providers/some-id`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    // Should return 401 Unauthorized
    expect(response.status).toBe(401);
  });

  test("should return null IdP logout URL for non-SSO user", async ({
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
        urlSuffix: "/api/identity-providers/idp-logout-url",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
      });

      expect(response.status()).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ url: null });
    } finally {
      await deleteApiKey(request, keyId);
    }
  });

  test("should require authentication for IdP logout URL", async () => {
    const response = await fetch(
      `${API_BASE_URL}/api/identity-providers/idp-logout-url`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    expect(response.status).toBe(401);
  });
});
