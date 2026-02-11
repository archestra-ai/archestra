import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  getAdditionalTrustedSsoProviderIds,
  getCorsOrigins,
  getDatabaseUrl,
  getOtelExporterOtlpEndpoint,
  getOtlpAuthHeaders,
  getTrustedOrigins,
  parseBodyLimit,
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

describe("getConfiguredOrigins (tested via getCorsOrigins/getTrustedOrigins)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should accept all origins when no env vars are set", () => {
    delete process.env.ARCHESTRA_FRONTEND_URL;
    delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

    const cors = getCorsOrigins();
    expect(cors).toHaveLength(1);
    expect(cors[0]).toBeInstanceOf(RegExp);

    const trusted = getTrustedOrigins();
    expect(trusted).toEqual([
      "http://*:*",
      "https://*:*",
      "http://*",
      "https://*",
    ]);
  });

  test("should parse ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS with trimming and filtering", () => {
    process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
      "  http://keycloak:8080 , , https://auth.example.com  ";
    delete process.env.ARCHESTRA_FRONTEND_URL;

    const result = getTrustedOrigins();

    expect(result).toContain("http://keycloak:8080");
    expect(result).toContain("https://auth.example.com");
    expect(result).toHaveLength(2);
  });
});

describe("getTrustedOrigins", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("no origin env vars (accept all)", () => {
    test("should return catch-all wildcards when no env vars are set", () => {
      delete process.env.ARCHESTRA_FRONTEND_URL;
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      const result = getTrustedOrigins();

      expect(result).toEqual([
        "http://*:*",
        "https://*:*",
        "http://*",
        "https://*",
      ]);
    });
  });

  describe("configured origins (enforce)", () => {
    test("should return frontend URL when set", () => {
      process.env.ARCHESTRA_FRONTEND_URL = "https://app.example.com";
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      expect(getTrustedOrigins()).toEqual(["https://app.example.com"]);
    });

    test("should combine frontend URL and additional origins", () => {
      process.env.ARCHESTRA_FRONTEND_URL = "https://app.example.com";
      process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
        "http://idp.example.com:8080";

      expect(getTrustedOrigins()).toEqual([
        "https://app.example.com",
        "http://idp.example.com:8080",
      ]);
    });

    test("should add 127.0.0.1 equivalent for localhost origins", () => {
      process.env.ARCHESTRA_FRONTEND_URL = "http://localhost:3000";
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      const result = getTrustedOrigins();
      expect(result).toContain("http://localhost:3000");
      expect(result).toContain("http://127.0.0.1:3000");
    });

    test("should add localhost equivalent for 127.0.0.1 origins", () => {
      process.env.ARCHESTRA_FRONTEND_URL = "http://127.0.0.1:3000";
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      const result = getTrustedOrigins();
      expect(result).toContain("http://127.0.0.1:3000");
      expect(result).toContain("http://localhost:3000");
    });

    test("should enforce only additional origins when frontend URL is not set", () => {
      delete process.env.ARCHESTRA_FRONTEND_URL;
      process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
        "https://auth.example.com";

      expect(getTrustedOrigins()).toEqual(["https://auth.example.com"]);
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

describe("parseBodyLimit", () => {
  const DEFAULT_VALUE = 1024; // 1KB default for testing

  describe("undefined or empty input", () => {
    test("should return default value when input is undefined", () => {
      expect(parseBodyLimit(undefined, DEFAULT_VALUE)).toBe(DEFAULT_VALUE);
    });

    test("should return default value when input is empty string", () => {
      expect(parseBodyLimit("", DEFAULT_VALUE)).toBe(DEFAULT_VALUE);
    });
  });

  describe("numeric bytes input", () => {
    test("should parse plain numeric value as bytes", () => {
      expect(parseBodyLimit("52428800", DEFAULT_VALUE)).toBe(52428800);
    });

    test("should parse small numeric value", () => {
      expect(parseBodyLimit("1024", DEFAULT_VALUE)).toBe(1024);
    });

    test("should parse zero", () => {
      expect(parseBodyLimit("0", DEFAULT_VALUE)).toBe(0);
    });
  });

  describe("human-readable format (KB)", () => {
    test("should parse KB lowercase", () => {
      expect(parseBodyLimit("100kb", DEFAULT_VALUE)).toBe(100 * 1024);
    });

    test("should parse KB uppercase", () => {
      expect(parseBodyLimit("100KB", DEFAULT_VALUE)).toBe(100 * 1024);
    });

    test("should parse KB mixed case", () => {
      expect(parseBodyLimit("100Kb", DEFAULT_VALUE)).toBe(100 * 1024);
    });
  });

  describe("human-readable format (MB)", () => {
    test("should parse MB lowercase", () => {
      expect(parseBodyLimit("50mb", DEFAULT_VALUE)).toBe(50 * 1024 * 1024);
    });

    test("should parse MB uppercase", () => {
      expect(parseBodyLimit("50MB", DEFAULT_VALUE)).toBe(50 * 1024 * 1024);
    });

    test("should parse MB mixed case", () => {
      expect(parseBodyLimit("50Mb", DEFAULT_VALUE)).toBe(50 * 1024 * 1024);
    });

    test("should parse 100MB correctly", () => {
      expect(parseBodyLimit("100MB", DEFAULT_VALUE)).toBe(100 * 1024 * 1024);
    });
  });

  describe("human-readable format (GB)", () => {
    test("should parse GB lowercase", () => {
      expect(parseBodyLimit("1gb", DEFAULT_VALUE)).toBe(1 * 1024 * 1024 * 1024);
    });

    test("should parse GB uppercase", () => {
      expect(parseBodyLimit("1GB", DEFAULT_VALUE)).toBe(1 * 1024 * 1024 * 1024);
    });

    test("should parse GB mixed case", () => {
      expect(parseBodyLimit("2Gb", DEFAULT_VALUE)).toBe(2 * 1024 * 1024 * 1024);
    });
  });

  describe("whitespace handling", () => {
    test("should handle leading whitespace", () => {
      expect(parseBodyLimit("  50MB", DEFAULT_VALUE)).toBe(50 * 1024 * 1024);
    });

    test("should handle trailing whitespace", () => {
      expect(parseBodyLimit("50MB  ", DEFAULT_VALUE)).toBe(50 * 1024 * 1024);
    });

    test("should handle surrounding whitespace", () => {
      expect(parseBodyLimit("  50MB  ", DEFAULT_VALUE)).toBe(50 * 1024 * 1024);
    });
  });

  describe("invalid input", () => {
    test("should return default value for invalid unit", () => {
      expect(parseBodyLimit("50TB", DEFAULT_VALUE)).toBe(DEFAULT_VALUE);
    });

    test("should return default value for text without numbers", () => {
      expect(parseBodyLimit("MB", DEFAULT_VALUE)).toBe(DEFAULT_VALUE);
    });

    test("should return default value for random text", () => {
      expect(parseBodyLimit("invalid", DEFAULT_VALUE)).toBe(DEFAULT_VALUE);
    });

    test("should return default value for negative with unit", () => {
      expect(parseBodyLimit("-50MB", DEFAULT_VALUE)).toBe(DEFAULT_VALUE);
    });

    test("should return default value for decimal with unit", () => {
      expect(parseBodyLimit("1.5MB", DEFAULT_VALUE)).toBe(DEFAULT_VALUE);
    });

    test("should return default value for space between number and unit", () => {
      expect(parseBodyLimit("50 MB", DEFAULT_VALUE)).toBe(DEFAULT_VALUE);
    });
  });
});

describe("getOtelExporterOtlpEndpoint", () => {
  describe("default value", () => {
    test("should return default endpoint when no value provided", () => {
      const result = getOtelExporterOtlpEndpoint(undefined);
      expect(result).toBe("http://localhost:4318/v1/traces");
    });

    test("should return default endpoint when empty string provided", () => {
      const result = getOtelExporterOtlpEndpoint("");
      expect(result).toBe("http://localhost:4318/v1/traces");
    });

    test("should return default endpoint when only whitespace provided", () => {
      const result = getOtelExporterOtlpEndpoint("   ");
      expect(result).toBe("http://localhost:4318/v1/traces");
    });
  });

  describe("URL already ends with /v1/traces", () => {
    test("should return URL as-is when it ends with /v1/traces", () => {
      const result = getOtelExporterOtlpEndpoint(
        "http://otel-collector:4318/v1/traces",
      );
      expect(result).toBe("http://otel-collector:4318/v1/traces");
    });

    test("should normalize trailing slashes and return URL with /v1/traces", () => {
      const result = getOtelExporterOtlpEndpoint(
        "http://otel-collector:4318/v1/traces/",
      );
      expect(result).toBe("http://otel-collector:4318/v1/traces");
    });

    test("should handle multiple trailing slashes", () => {
      const result = getOtelExporterOtlpEndpoint(
        "http://otel-collector:4318/v1/traces///",
      );
      expect(result).toBe("http://otel-collector:4318/v1/traces");
    });
  });

  describe("URL ends with /v1", () => {
    test("should append /traces when URL ends with /v1", () => {
      const result = getOtelExporterOtlpEndpoint(
        "http://otel-collector:4318/v1",
      );
      expect(result).toBe("http://otel-collector:4318/v1/traces");
    });

    test("should handle /v1 with trailing slash", () => {
      const result = getOtelExporterOtlpEndpoint(
        "http://otel-collector:4318/v1/",
      );
      expect(result).toBe("http://otel-collector:4318/v1/traces");
    });
  });

  describe("URL without /v1/traces suffix", () => {
    test("should append /v1/traces to base URL", () => {
      const result = getOtelExporterOtlpEndpoint("http://otel-collector:4318");
      expect(result).toBe("http://otel-collector:4318/v1/traces");
    });

    test("should append /v1/traces to URL with trailing slash", () => {
      const result = getOtelExporterOtlpEndpoint("http://otel-collector:4318/");
      expect(result).toBe("http://otel-collector:4318/v1/traces");
    });

    test("should append /v1/traces to URL with custom path", () => {
      const result = getOtelExporterOtlpEndpoint(
        "http://otel-collector:4318/custom",
      );
      expect(result).toBe("http://otel-collector:4318/custom/v1/traces");
    });

    test("should handle $(NODE_IP) variable expansion syntax", () => {
      const result = getOtelExporterOtlpEndpoint("http://$(NODE_IP):4317");
      expect(result).toBe("http://$(NODE_IP):4317/v1/traces");
    });

    test("should preserve $(NODE_IP) and append /v1/traces", () => {
      const result = getOtelExporterOtlpEndpoint(
        "http://$(NODE_IP):4317/custom/path",
      );
      expect(result).toBe("http://$(NODE_IP):4317/custom/path/v1/traces");
    });
  });

  describe("HTTPS URLs", () => {
    test("should work with HTTPS URLs", () => {
      const result = getOtelExporterOtlpEndpoint("https://otel.example.com");
      expect(result).toBe("https://otel.example.com/v1/traces");
    });

    test("should work with HTTPS URLs that already have /v1/traces", () => {
      const result = getOtelExporterOtlpEndpoint(
        "https://otel.example.com/v1/traces",
      );
      expect(result).toBe("https://otel.example.com/v1/traces");
    });
  });

  describe("edge cases", () => {
    test("should handle URL with port but no path", () => {
      const result = getOtelExporterOtlpEndpoint("http://localhost:4317");
      expect(result).toBe("http://localhost:4317/v1/traces");
    });

    test("should handle URL without port", () => {
      const result = getOtelExporterOtlpEndpoint("http://otel-collector");
      expect(result).toBe("http://otel-collector/v1/traces");
    });

    test("should fix common typo /v1/trace (missing s) to /v1/traces", () => {
      // URL ending in /v1/trace (missing s) should be normalized to /v1/traces
      const result = getOtelExporterOtlpEndpoint(
        "http://otel-collector:4318/v1/trace",
      );
      expect(result).toBe("http://otel-collector:4318/v1/traces");
    });
  });
});

describe("getCorsOrigins", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("no origin env vars (accept all)", () => {
    test("should return catch-all regex when no env vars are set", () => {
      delete process.env.ARCHESTRA_FRONTEND_URL;
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      const result = getCorsOrigins();

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(RegExp);
      expect((result[0] as RegExp).test("http://anything.example.com")).toBe(
        true,
      );
    });
  });

  describe("configured origins (enforce)", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    test("should return frontend URL when set", async () => {
      process.env.NODE_ENV = "production";
      process.env.ARCHESTRA_FRONTEND_URL = "https://app.example.com";
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      const { getCorsOrigins: fn } = await import("./config");
      expect(fn()).toEqual(["https://app.example.com"]);
    });

    test("should combine frontend URL and additional origins", async () => {
      process.env.NODE_ENV = "production";
      process.env.ARCHESTRA_FRONTEND_URL = "https://app.example.com";
      process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS =
        "http://idp.example.com:8080";

      const { getCorsOrigins: fn } = await import("./config");
      expect(fn()).toEqual([
        "https://app.example.com",
        "http://idp.example.com:8080",
      ]);
    });

    test("should add loopback equivalents for localhost origins", async () => {
      process.env.NODE_ENV = "production";
      process.env.ARCHESTRA_FRONTEND_URL = "http://localhost:3000";
      delete process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS;

      const { getCorsOrigins: fn } = await import("./config");
      const result = fn();
      expect(result).toContain("http://localhost:3000");
      expect(result).toContain("http://127.0.0.1:3000");
    });
  });
});
