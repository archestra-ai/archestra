import { vi } from "vitest";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import {
  getCorsOrigins,
  getDatabaseUrl,
  getOtelExporterOtlpEndpoint,
  getOtelExporterOtlpLogEndpoint,
  getOtlpAuthHeaders,
  getTrustedOrigins,
  parseBodyLimit,
  parseCommaSeparatedList,
  parseConnectorSyncMaxDuration,
  parseContentMaxLength,
  parseProcessType,
  parseSampleRate,
  parseTrustProxy,
  parseVirtualKeyDefaultExpiration,
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

describe("getOtelExporterOtlpLogEndpoint", () => {
  const savedEnv = process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT;

  afterAll(() => {
    if (savedEnv !== undefined) {
      process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT = savedEnv;
    } else {
      delete process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT;
    }
  });

  describe("default value", () => {
    test("should return default endpoint when no value provided", () => {
      delete process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT;
      const result = getOtelExporterOtlpLogEndpoint(undefined);
      expect(result).toBe("http://localhost:4318/v1/logs");
    });

    test("should return default endpoint when empty string provided", () => {
      const result = getOtelExporterOtlpLogEndpoint("");
      expect(result).toBe("http://localhost:4318/v1/logs");
    });

    test("should return default endpoint when only whitespace provided", () => {
      const result = getOtelExporterOtlpLogEndpoint("   ");
      expect(result).toBe("http://localhost:4318/v1/logs");
    });
  });

  describe("URL already ends with /v1/logs", () => {
    test("should return URL as-is when it ends with /v1/logs", () => {
      const result = getOtelExporterOtlpLogEndpoint(
        "http://otel-collector:4318/v1/logs",
      );
      expect(result).toBe("http://otel-collector:4318/v1/logs");
    });

    test("should normalize trailing slashes and return URL with /v1/logs", () => {
      const result = getOtelExporterOtlpLogEndpoint(
        "http://otel-collector:4318/v1/logs/",
      );
      expect(result).toBe("http://otel-collector:4318/v1/logs");
    });
  });

  describe("URL ends with /v1", () => {
    test("should append /logs when URL ends with /v1", () => {
      const result = getOtelExporterOtlpLogEndpoint(
        "http://otel-collector:4318/v1",
      );
      expect(result).toBe("http://otel-collector:4318/v1/logs");
    });

    test("should handle /v1 with trailing slash", () => {
      const result = getOtelExporterOtlpLogEndpoint(
        "http://otel-collector:4318/v1/",
      );
      expect(result).toBe("http://otel-collector:4318/v1/logs");
    });
  });

  describe("URL without /v1/logs suffix", () => {
    test("should append /v1/logs to base URL", () => {
      const result = getOtelExporterOtlpLogEndpoint(
        "http://otel-collector:4318",
      );
      expect(result).toBe("http://otel-collector:4318/v1/logs");
    });

    test("should append /v1/logs to URL with trailing slash", () => {
      const result = getOtelExporterOtlpLogEndpoint(
        "http://otel-collector:4318/",
      );
      expect(result).toBe("http://otel-collector:4318/v1/logs");
    });
  });

  describe("HTTPS URLs", () => {
    test("should work with HTTPS URLs", () => {
      const result = getOtelExporterOtlpLogEndpoint("https://otel.example.com");
      expect(result).toBe("https://otel.example.com/v1/logs");
    });

    test("should work with HTTPS URLs that already have /v1/logs", () => {
      const result = getOtelExporterOtlpLogEndpoint(
        "https://otel.example.com/v1/logs",
      );
      expect(result).toBe("https://otel.example.com/v1/logs");
    });
  });
});

describe("parseContentMaxLength", () => {
  test("should return default 10000 when no value provided", () => {
    expect(parseContentMaxLength(undefined)).toBe(10_000);
  });

  test("should return default when empty string provided", () => {
    expect(parseContentMaxLength("")).toBe(10_000);
  });

  test("should return default when whitespace-only string provided", () => {
    expect(parseContentMaxLength("   ")).toBe(10_000);
  });

  test("should parse valid integer value", () => {
    expect(parseContentMaxLength("5000")).toBe(5000);
  });

  test("should parse large value", () => {
    expect(parseContentMaxLength("100000")).toBe(100_000);
  });

  test("should trim whitespace and parse value", () => {
    expect(parseContentMaxLength("  8000  ")).toBe(8000);
  });

  test("should return default and warn for non-numeric value", () => {
    expect(parseContentMaxLength("abc")).toBe(10_000);
    expect(logger.warn).toHaveBeenCalledWith(
      'Invalid ARCHESTRA_OTEL_CONTENT_MAX_LENGTH value "abc", using default 10000',
    );
  });

  test("should return default and warn for zero", () => {
    expect(parseContentMaxLength("0")).toBe(10_000);
    expect(logger.warn).toHaveBeenCalledWith(
      'Invalid ARCHESTRA_OTEL_CONTENT_MAX_LENGTH value "0", using default 10000',
    );
  });

  test("should return default and warn for negative value", () => {
    expect(parseContentMaxLength("-100")).toBe(10_000);
    expect(logger.warn).toHaveBeenCalledWith(
      'Invalid ARCHESTRA_OTEL_CONTENT_MAX_LENGTH value "-100", using default 10000',
    );
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

describe("parseVirtualKeyDefaultExpiration", () => {
  test("should return default 2592000 when undefined", () => {
    expect(parseVirtualKeyDefaultExpiration(undefined)).toBe(2592000);
  });

  test("should return default when empty string", () => {
    expect(parseVirtualKeyDefaultExpiration("")).toBe(2592000);
  });

  test("should return default when whitespace-only", () => {
    expect(parseVirtualKeyDefaultExpiration("   ")).toBe(2592000);
  });

  test("should parse valid positive integer", () => {
    expect(parseVirtualKeyDefaultExpiration("86400")).toBe(86400);
  });

  test("should return 0 for zero (never expires)", () => {
    expect(parseVirtualKeyDefaultExpiration("0")).toBe(0);
  });

  test("should return default and warn for negative value", () => {
    expect(parseVirtualKeyDefaultExpiration("-100")).toBe(2592000);
    expect(logger.warn).toHaveBeenCalledWith(
      'Invalid ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS value "-100", using default 2592000',
    );
  });

  test("should return default and warn for non-numeric value", () => {
    expect(parseVirtualKeyDefaultExpiration("abc")).toBe(2592000);
    expect(logger.warn).toHaveBeenCalledWith(
      'Invalid ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS value "abc", using default 2592000',
    );
  });

  test("should trim whitespace and parse", () => {
    expect(parseVirtualKeyDefaultExpiration("  3600  ")).toBe(3600);
  });

  test("should cap values exceeding 1 year to 31536000", () => {
    expect(parseVirtualKeyDefaultExpiration("100000000")).toBe(31_536_000);
    expect(logger.warn).toHaveBeenCalledWith(
      'ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS value "100000000" exceeds maximum (31536000s / 1 year), capping to 31536000',
    );
  });

  test("should allow exactly 1 year (31536000)", () => {
    expect(parseVirtualKeyDefaultExpiration("31536000")).toBe(31_536_000);
  });

  test("should cap value just over 1 year", () => {
    expect(parseVirtualKeyDefaultExpiration("31536001")).toBe(31_536_000);
  });
});

describe("parseConnectorSyncMaxDuration", () => {
  test("should return default 3300 when undefined", () => {
    expect(parseConnectorSyncMaxDuration(undefined)).toBe(3300);
  });

  test("should return default 3300 when empty string", () => {
    expect(parseConnectorSyncMaxDuration("")).toBe(3300);
  });

  test("should parse valid positive integer", () => {
    expect(parseConnectorSyncMaxDuration("1800")).toBe(1800);
  });

  test("should return undefined for zero (disables time-bounded runs)", () => {
    expect(parseConnectorSyncMaxDuration("0")).toBeUndefined();
  });

  test("should return undefined for negative value", () => {
    expect(parseConnectorSyncMaxDuration("-100")).toBeUndefined();
  });

  test("should return undefined for non-numeric value", () => {
    expect(parseConnectorSyncMaxDuration("abc")).toBeUndefined();
  });

  test("should parse large value", () => {
    expect(parseConnectorSyncMaxDuration("7200")).toBe(7200);
  });
});

describe("parseProcessType", () => {
  test("should return 'all' when undefined", () => {
    expect(parseProcessType(undefined)).toBe("all");
  });

  test("should return 'all' when empty string", () => {
    expect(parseProcessType("")).toBe("all");
  });

  test("should return 'web' for 'web'", () => {
    expect(parseProcessType("web")).toBe("web");
  });

  test("should return 'worker' for 'worker'", () => {
    expect(parseProcessType("worker")).toBe("worker");
  });

  test("should be case insensitive", () => {
    expect(parseProcessType("WEB")).toBe("web");
    expect(parseProcessType("WORKER")).toBe("worker");
    expect(parseProcessType("Web")).toBe("web");
    expect(parseProcessType("Worker")).toBe("worker");
  });

  test("should return 'all' for unknown values", () => {
    expect(parseProcessType("unknown")).toBe("all");
    expect(parseProcessType("both")).toBe("all");
    expect(parseProcessType("api")).toBe("all");
  });

  test.each([
    { input: undefined, processType: "all", webServer: true, worker: true },
    { input: "", processType: "all", webServer: true, worker: true },
    { input: "all", processType: "all", webServer: true, worker: true },
    { input: "web", processType: "web", webServer: true, worker: false },
    { input: "WEB", processType: "web", webServer: true, worker: false },
    { input: "worker", processType: "worker", webServer: false, worker: true },
    { input: "WORKER", processType: "worker", webServer: false, worker: true },
    { input: "unknown", processType: "all", webServer: true, worker: true },
  ])("input=$input → shouldRunWebServer=$webServer, shouldRunWorker=$worker", ({
    input,
    processType,
    webServer,
    worker,
  }) => {
    const result = parseProcessType(input);
    expect(result).toBe(processType);
    // These match the derivation: shouldRunWebServer = processType !== "worker", shouldRunWorker = processType !== "web"
    expect(result !== "worker").toBe(webServer);
    expect(result !== "web").toBe(worker);
  });
});

describe("parseSampleRate", () => {
  test("should return default when undefined", () => {
    expect(parseSampleRate(undefined, 0.2)).toBe(0.2);
  });

  test("should return default when empty string", () => {
    expect(parseSampleRate("", 0.05)).toBe(0.05);
  });

  test("should parse valid rate", () => {
    expect(parseSampleRate("0.5", 0.2)).toBe(0.5);
  });

  test("should parse 0", () => {
    expect(parseSampleRate("0", 0.2)).toBe(0);
  });

  test("should parse 1", () => {
    expect(parseSampleRate("1", 0.2)).toBe(1);
  });

  test("should return default for value above 1", () => {
    expect(parseSampleRate("1.5", 0.2)).toBe(0.2);
  });

  test("should return default for negative value", () => {
    expect(parseSampleRate("-0.1", 0.3)).toBe(0.3);
  });

  test("should return default for non-numeric value", () => {
    expect(parseSampleRate("abc", 0.1)).toBe(0.1);
  });
});

describe("parseCommaSeparatedList", () => {
  test("should parse comma-separated values", () => {
    expect(parseCommaSeparatedList("anthropic,amazon")).toEqual([
      "anthropic",
      "amazon",
    ]);
  });

  test("should trim whitespace from values", () => {
    expect(parseCommaSeparatedList(" anthropic , amazon ")).toEqual([
      "anthropic",
      "amazon",
    ]);
  });

  test("should return empty array for empty string", () => {
    expect(parseCommaSeparatedList("")).toEqual([]);
  });

  test("should filter out empty entries from extra commas", () => {
    expect(parseCommaSeparatedList("anthropic,,amazon,")).toEqual([
      "anthropic",
      "amazon",
    ]);
  });

  test("should handle single value", () => {
    expect(parseCommaSeparatedList("anthropic")).toEqual(["anthropic"]);
  });
});

describe("parseTrustProxy", () => {
  test("should return false when undefined", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
  });

  test("should return false when empty string", () => {
    expect(parseTrustProxy("")).toBe(false);
  });

  test("should return false when whitespace-only", () => {
    expect(parseTrustProxy("   ")).toBe(false);
  });

  test('should return false for "false"', () => {
    expect(parseTrustProxy("false")).toBe(false);
  });

  test('should return true for "true"', () => {
    expect(parseTrustProxy("true")).toBe(true);
  });

  test("should trim whitespace and return true", () => {
    expect(parseTrustProxy("  true  ")).toBe(true);
  });

  test("should return string for a single IP", () => {
    expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
  });

  test("should return string for a single CIDR", () => {
    expect(parseTrustProxy("192.168.1.0/24")).toBe("192.168.1.0/24");
  });

  test("should return normalised string for comma-separated IPs", () => {
    expect(parseTrustProxy("127.0.0.1,10.0.0.1")).toBe("127.0.0.1,10.0.0.1");
  });

  test("should return normalised string for comma-separated CIDRs", () => {
    expect(parseTrustProxy("10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")).toBe(
      "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    );
  });

  test("should trim whitespace around each IP in a comma-separated list", () => {
    expect(parseTrustProxy("  127.0.0.1 , 10.0.0.1  ")).toBe(
      "127.0.0.1,10.0.0.1",
    );
  });

  test("should filter empty entries from extra commas", () => {
    expect(parseTrustProxy("127.0.0.1,,10.0.0.1")).toBe("127.0.0.1,10.0.0.1");
  });
});
