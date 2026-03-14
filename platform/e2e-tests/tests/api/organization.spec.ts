import { readFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { TestFixtures } from "./fixtures";
import { expect, test } from "./fixtures";

// Helper to clean up appearance fields after tests
const cleanupAppearance = async (
  request: APIRequestContext,
  makeApiRequest: TestFixtures["makeApiRequest"],
  data: Record<string, unknown>,
) => {
  try {
    await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data,
    });
  } catch {
    // Ignore cleanup errors
  }
};

// Test constants
const VALID_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";

const INVALID_JPEG_BASE64 = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const INVALID_BASE64_PAYLOAD = "data:image/png;base64,NotAnImageJustText";
const NON_PNG_BASE64 = "data:image/png;base64,SGVsbG8gV29ybGQ="; // "Hello World"

// Helper function to create oversized logo data URI
const createOversizedLogoDataUri = (): string => {
  const oversizedPng = readFileSync(
    path.join(__dirname, "fixtures", "logo.png"),
  );
  return `data:image/png;base64,${oversizedPng.toString("base64")}`;
};

// Helper function to validate error response structure
const expectValidationError = async (
  response: APIResponse,
  expectedStatus = 400,
) => {
  expect(response.status()).toBe(expectedStatus);

  const body = await response.json();
  expect(body).toHaveProperty("error");
  expect(body.error).toHaveProperty("message");
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);

  return body;
};

// Helper function for cleanup
const cleanupLogo = async (
  request: APIRequestContext,
  makeApiRequest: TestFixtures["makeApiRequest"],
) => {
  try {
    await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { logo: null },
    });
  } catch (error) {
    // Ignore cleanup errors to avoid test failures
    console.warn("Failed to cleanup logo:", error);
  }
};

test.describe("Organization API logo validation", () => {
  test.describe("Error handling", () => {
    test("should reject invalid Base64 payload with proper error response", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { logo: INVALID_BASE64_PAYLOAD },
        ignoreStatusCheck: true,
      });

      const errorBody = await expectValidationError(response);
      expect(errorBody.error.message).toContain("Base64");
    });

    test("should reject valid Base64 with non-PNG content with proper error response", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { logo: NON_PNG_BASE64 },
        ignoreStatusCheck: true,
      });

      const errorBody = await expectValidationError(response);
      expect(errorBody.error.message).toContain("PNG");
    });

    test("should reject wrong MIME type prefix with proper error response", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { logo: INVALID_JPEG_BASE64 },
        ignoreStatusCheck: true,
      });

      const errorBody = await expectValidationError(response);
      expect(errorBody.error.message).toContain("PNG");
    });

    test("should reject oversized PNG logo", async ({
      request,
      makeApiRequest,
    }) => {
      const oversizedLogo = createOversizedLogoDataUri();

      const response = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { logo: oversizedLogo },
        ignoreStatusCheck: true,
      });

      // 3MB PNG exceeds Fastify's default 1MB body limit → 500
      expect(response.status()).toBe(500);
    });
  });

  test.describe("Success cases", () => {
    test("should accept valid PNG logo and return correct response", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { logo: VALID_PNG_BASE64 },
      });

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("logo");
      expect(body.logo).toBe(VALID_PNG_BASE64);
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("name");

      // Cleanup
      await cleanupLogo(request, makeApiRequest);
    });

    test("should accept null logo (removal) and maintain other fields", async ({
      request,
      makeApiRequest,
    }) => {
      // First set a logo
      await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { logo: VALID_PNG_BASE64 },
      });

      // Then remove it
      const response = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization/appearance-settings",
        data: { logo: null },
      });

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.logo).toBeNull();
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("name");
    });
  });
});

test.describe("Organization settings - new fields", () => {
  test("should update and retrieve appName", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { appName: "My Custom App" },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.appName).toBe("My Custom App");

    await cleanupAppearance(request, makeApiRequest, { appName: null });
  });

  test("should reject appName exceeding 100 characters", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { appName: "a".repeat(101) },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(400);
  });

  test("should update and retrieve ogDescription", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { ogDescription: "Custom OG description" },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ogDescription).toBe("Custom OG description");

    await cleanupAppearance(request, makeApiRequest, { ogDescription: null });
  });

  test("should update and retrieve footerText", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { footerText: "© 2026 Custom Footer" },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.footerText).toBe("© 2026 Custom Footer");

    await cleanupAppearance(request, makeApiRequest, { footerText: null });
  });

  test("should reject footerText exceeding 500 characters", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { footerText: "a".repeat(501) },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(400);
  });

  test("should update and retrieve chatPlaceholders", async ({
    request,
    makeApiRequest,
  }) => {
    const placeholders = ["Ask me anything", "How can I help?"];
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { chatPlaceholders: placeholders },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.chatPlaceholders).toEqual(placeholders);

    await cleanupAppearance(request, makeApiRequest, {
      chatPlaceholders: null,
    });
  });

  test("should reject chatPlaceholders exceeding 20 entries", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: {
        chatPlaceholders: Array.from({ length: 21 }, (_, i) => `Item ${i}`),
      },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(400);
  });

  test("should reject chatPlaceholders with entry exceeding 80 chars", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { chatPlaceholders: ["a".repeat(81)] },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(400);
  });

  test("should update showTwoFactor toggle", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { showTwoFactor: true },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.showTwoFactor).toBe(true);

    // Reset
    await cleanupAppearance(request, makeApiRequest, { showTwoFactor: false });
  });

  test("should accept favicon as valid PNG", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: { favicon: VALID_PNG_BASE64 },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.favicon).toBe(VALID_PNG_BASE64);

    await cleanupAppearance(request, makeApiRequest, { favicon: null });
  });

  test("should update multiple fields at once", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/appearance-settings",
      data: {
        appName: "Multi-update Test",
        footerText: "Test Footer",
        showTwoFactor: true,
        chatPlaceholders: ["Hello", "World"],
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.appName).toBe("Multi-update Test");
    expect(body.footerText).toBe("Test Footer");
    expect(body.showTwoFactor).toBe(true);
    expect(body.chatPlaceholders).toEqual(["Hello", "World"]);

    // Verify public appearance endpoint reflects the same fields
    const publicResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/appearance-settings",
    });
    expect(publicResponse.status()).toBe(200);
    const publicBody = await publicResponse.json();
    expect(publicBody.appName).toBe("Multi-update Test");

    // Cleanup
    await cleanupAppearance(request, makeApiRequest, {
      appName: null,
      footerText: null,
      showTwoFactor: false,
      chatPlaceholders: null,
    });
  });
});
