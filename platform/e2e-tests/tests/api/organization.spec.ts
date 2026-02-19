import { readFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { TestFixtures } from "./fixtures";
import { expect, test } from "./fixtures";

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
      urlSuffix: "/api/organization",
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
        urlSuffix: "/api/organization",
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
        urlSuffix: "/api/organization",
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
        urlSuffix: "/api/organization",
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
        urlSuffix: "/api/organization",
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
        urlSuffix: "/api/organization",
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
        urlSuffix: "/api/organization",
        data: { logo: VALID_PNG_BASE64 },
      });

      // Then remove it
      const response = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: "/api/organization",
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
