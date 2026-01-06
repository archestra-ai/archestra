import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  getAdditionalTrustedOrigins,
  getAdditionalTrustedSsoProviderIds,
  getDatabaseUrl,
  getOtlpAuthHeaders,
  getTrustedOrigins,
} from "./config";

// Mock the logger
vi.mock("./logging", () => ({
  __esModule: true,
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import logger from "./logging";

describe("getDatabaseUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Create a fresh copy of process.env for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore the original environment
    process.env = originalEnv;
  });

  test("should use ARCHESTRA_DATABASE_URL when both ARCHESTRA_DATABASE_URL and DATABASE_URL are set", () => {
    process.env.ARCHESTRA_DATABASE_URL =
      "postgresql://archestra:pass@host:5432/archestra_db";
    process.env.DATABASE_URL = "postgresql://other:pass@host:5432/other_db";

    const result = getDatabaseUrl();

    expect(result).toBe("postgresql://archestra:pass@host:5432/archestra_db");
  });

  test("should use DATABASE_URL when only DATABASE_URL is set", () => {
    delete process.env.ARCHESTRA_DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://other:pass@host:5432/other_db";

    const result = getDatabaseUrl();

    expect(result).toBe("postgresql://other:pass@host:5432/other_db");
  });

  test("should use ARCHESTRA_DATABASE_URL when only ARCHESTRA_DATABASE_URL is set", () => {
    process.env.ARCHESTRA_DATABASE_URL =
      "postgresql://archestra:pass@host:5432/archestra_db";
    delete process.env.DATABASE_URL;

    const result = getDatabaseUrl();

    expect(result).toBe("postgresql://archestra:pass@host:5432/archestra_db");
  });

  test("should throw an error when neither ARCHESTRA_DATABASE_URL nor DATABASE_URL is set", () => {
    delete process.env.ARCHESTRA_DATABASE_URL;
    delete process.env.DATABASE_URL;

    expect(() => getDatabaseUrl()).toThrow(
      "Database URL is not set. Please set ARCHESTRA_DATABASE_URL or DATABASE_URL",
    );
  });

  test("should throw an error when both are empty strings", () => {
    process.env.ARCHESTRA_DATABASE_URL = "";
    process.env.DATABASE_URL = "";

    expect(() => getDatabaseUrl()).toThrow(
      "Database URL is not set. Please set ARCHESTRA_DATABASE_URL or DATABASE_URL",
    );
  });

  test("should use DATABASE_URL when ARCHESTRA_DATABASE_URL is empty string", () => {
    process.env.ARCHESTRA_DATABASE_URL = "";
    process.env.DATABASE_URL = "postgresql://other:pass@host:5432/other_db";

    const result = getDatabaseUrl();

    expect(result).toBe("postgresql://other:pass@host:5432/other_db");
  });
});

describe("getOtlpAuthHeaders", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Create a fresh copy of process.env for each test
    process.env = { ...originalEnv };
    // Clear mock calls
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore the original environment
    process.env = originalEnv;
  });

  describe("Bearer token authentication", () => {
    test("should return Bearer authorization header when bearer token is provided", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER = "my-bearer-token";

      const result = getOtlpAuthHeaders();

      expect(result).toEqual({
        Authorization: "Bearer my-bearer-token",
      });
    });

    test("should prioritize bearer token over basic auth when both are provided", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER = "my-bearer-token";
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME = "user";
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD = "pass";

      const result = getOtlpAuthHeaders();

      expect(result).toEqual({
        Authorization: "Bearer my-bearer-token",
      });
    });

    test("should trim whitespace from bearer token", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER =
        "  my-bearer-token  ";

      const result = getOtlpAuthHeaders();

      expect(result).toEqual({
        Authorization: "Bearer my-bearer-token",
      });
    });
  });

  describe("Basic authentication", () => {
    test("should return Basic authorization header when both username and password are provided", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME = "testuser";
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD = "testpass";

      const result = getOtlpAuthHeaders();

      // testuser:testpass in base64 is dGVzdHVzZXI6dGVzdHBhc3M=
      expect(result).toEqual({
        Authorization: "Basic dGVzdHVzZXI6dGVzdHBhc3M=",
      });
    });

    test("should trim whitespace from username and password", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME = "  testuser  ";
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD = "  testpass  ";

      const result = getOtlpAuthHeaders();

      expect(result).toEqual({
        Authorization: "Basic dGVzdHVzZXI6dGVzdHBhc3M=",
      });
    });

    test("should return undefined and warn when only username is provided", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME = "testuser";
      delete process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD;

      const result = getOtlpAuthHeaders();

      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "OTEL authentication misconfigured: both ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME and ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD must be provided for basic auth",
      );
    });

    test("should return undefined and warn when only password is provided", () => {
      delete process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME;
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD = "testpass";

      const result = getOtlpAuthHeaders();

      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "OTEL authentication misconfigured: both ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME and ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD must be provided for basic auth",
      );
    });

    test("should return undefined and warn when username is empty string", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME = "";
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD = "testpass";

      const result = getOtlpAuthHeaders();

      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "OTEL authentication misconfigured: both ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME and ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD must be provided for basic auth",
      );
    });

    test("should return undefined and warn when password is empty string", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME = "testuser";
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD = "";

      const result = getOtlpAuthHeaders();

      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "OTEL authentication misconfigured: both ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME and ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD must be provided for basic auth",
      );
    });
  });

  describe("No authentication", () => {
    test("should return undefined when no authentication environment variables are set", () => {
      delete process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER;
      delete process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME;
      delete process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD;

      const result = getOtlpAuthHeaders();

      expect(result).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test("should return undefined when all authentication variables are empty strings", () => {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER = "";
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME = "";
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD = "";

      const result = getOtlpAuthHeaders();

      expect(result).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});

describe("getAdditionalTrustedOrigins", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should return empty array when env var is not set", () => {
    delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

    const result = getAdditionalTrustedOrigins();

    expect(result).toEqual([]);
  });

  test("should return empty array when env var is empty", () => {
    process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS = "";

    const result = getAdditionalTrustedOrigins();

    expect(result).toEqual([]);
  });

  test("should return single origin", () => {
    process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
      "http://keycloak:8080";

    const result = getAdditionalTrustedOrigins();

    expect(result).toEqual(["http://keycloak:8080"]);
  });

  test("should return multiple origins from comma-separated list", () => {
    process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
      "http://keycloak:8080,https://auth.example.com,http://idp.local:9000";

    const result = getAdditionalTrustedOrigins();

    expect(result).toEqual([
      "http://keycloak:8080",
      "https://auth.example.com",
      "http://idp.local:9000",
    ]);
  });

  test("should trim whitespace from origins", () => {
    process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
      "  http://keycloak:8080 , https://auth.example.com  ";

    const result = getAdditionalTrustedOrigins();

    expect(result).toEqual([
      "http://keycloak:8080",
      "https://auth.example.com",
    ]);
  });

  test("should filter out empty entries", () => {
    process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
      "http://keycloak:8080,,https://auth.example.com,";

    const result = getAdditionalTrustedOrigins();

    expect(result).toEqual([
      "http://keycloak:8080",
      "https://auth.example.com",
    ]);
  });
});

describe("getTrustedOrigins", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("development mode (default localhost origins)", () => {
    // Note: NODE_ENV is determined at module load time, so tests run in development mode
    // since the test environment is not production

    test("should return localhost wildcards in development", () => {
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      const result = getTrustedOrigins();

      expect(result).toEqual([
        "http://localhost:*",
        "https://localhost:*",
        "http://127.0.0.1:*",
        "https://127.0.0.1:*",
      ]);
    });

    test("should include additional trusted origins in development", () => {
      process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
        "http://keycloak:8080";

      const result = getTrustedOrigins();

      expect(result).toEqual([
        "http://localhost:*",
        "https://localhost:*",
        "http://127.0.0.1:*",
        "https://127.0.0.1:*",
        "http://keycloak:8080",
      ]);
    });
  });

  describe("production mode (specific frontend URL)", () => {
    // Note: These tests use dynamic imports with vi.resetModules() to test production behavior
    // because NODE_ENV is evaluated at module load time

    beforeEach(() => {
      vi.resetModules();
    });

    test("should return frontend URL in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.ARCHESTRA_FRONTEND_URL = "https://app.example.com";
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      const { getTrustedOrigins: getTrustedOriginsProd } = await import(
        "./config"
      );
      const result = getTrustedOriginsProd();

      expect(result).toEqual(["https://app.example.com"]);
    });

    test("should include additional trusted origins in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.ARCHESTRA_FRONTEND_URL = "https://app.example.com";
      process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
        "http://idp.example.com:8080";

      const { getTrustedOrigins: getTrustedOriginsProd } = await import(
        "./config"
      );
      const result = getTrustedOriginsProd();

      expect(result).toEqual([
        "https://app.example.com",
        "http://idp.example.com:8080",
      ]);
    });
  });
});

describe("getAdditionalTrustedSsoProviderIds", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should return empty array when env var is not set", () => {
    delete process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS;

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual([]);
  });

  test("should return empty array when env var is empty string", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS = "";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual([]);
  });

  test("should return empty array when env var is only whitespace", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS = "   ";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual([]);
  });

  test("should parse single provider ID", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS = "okta";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual(["okta"]);
  });

  test("should parse multiple comma-separated provider IDs", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS = "okta,auth0,azure-ad";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual(["okta", "auth0", "azure-ad"]);
  });

  test("should trim whitespace from provider IDs", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS =
      "  okta  ,  auth0  ,  azure-ad  ";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual(["okta", "auth0", "azure-ad"]);
  });

  test("should trim leading and trailing whitespace from entire string", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS =
      "  okta,auth0,azure-ad  ";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual(["okta", "auth0", "azure-ad"]);
  });

  test("should filter out empty entries from extra commas", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS =
      "okta,,auth0,,,azure-ad";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual(["okta", "auth0", "azure-ad"]);
  });

  test("should filter out whitespace-only entries", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS = "okta,   ,auth0";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual(["okta", "auth0"]);
  });

  test("should handle provider IDs with hyphens and underscores", () => {
    process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS =
      "my-provider,another_provider,provider123";

    const result = getAdditionalTrustedSsoProviderIds();

    expect(result).toEqual(["my-provider", "another_provider", "provider123"]);
  });
});
