import { expect } from "@playwright/test";
import { test } from "./fixtures";

test.describe("SSO Providers API", () => {
  test("should list SSO providers", async ({
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
});
