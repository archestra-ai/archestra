import { describe, expect, test } from "@/test";
import type { InternalMcpCatalog } from "@/types";
import { constructHttpServiceName, constructK8sSecretName } from "./naming";

describe("constructK8sSecretName", () => {
  test.each([
    {
      testName: "constructs secret name with valid UUID",
      mcpServerId: "123e4567-e89b-12d3-a456-426614174000",
      expected: "mcp-server-123e4567-e89b-12d3-a456-426614174000-secrets",
    },
    {
      testName: "constructs secret name with simple ID",
      mcpServerId: "simple-id",
      expected: "mcp-server-simple-id-secrets",
    },
    {
      testName: "constructs secret name with numeric ID",
      mcpServerId: "12345",
      expected: "mcp-server-12345-secrets",
    },
    {
      testName: "constructs secret name with alphanumeric ID",
      mcpServerId: "abc123def456",
      expected: "mcp-server-abc123def456-secrets",
    },
  ])("$testName", ({ mcpServerId, expected }) => {
    const result = constructK8sSecretName(mcpServerId);
    expect(result).toBe(expected);
    expect(result).toMatch(/^mcp-server-.+-secrets$/);
  });

  test("multitenant catalogs share one catalog-stable secret", () => {
    const catalogItem = { multitenant: true } as InternalMcpCatalog;
    const catalogId = "123e4567-e89b-12d3-a456-426614174000";

    expect(constructK8sSecretName("server-a", catalogItem, catalogId)).toBe(
      "mcp-server-mt-123e4567-secrets",
    );
    // Two installs of the same multitenant catalog resolve to the same name.
    expect(constructK8sSecretName("server-b", catalogItem, catalogId)).toBe(
      constructK8sSecretName("server-a", catalogItem, catalogId),
    );
  });

  test("falls back to the per-install name when the catalog id is missing", () => {
    const catalogItem = { multitenant: true } as InternalMcpCatalog;

    expect(constructK8sSecretName("server-a", catalogItem, null)).toBe(
      "mcp-server-server-a-secrets",
    );
  });
});

describe("constructHttpServiceName", () => {
  test("appends the service suffix to an ordinary deployment name", () => {
    expect(constructHttpServiceName("mcp-weather-abc12345")).toBe(
      "mcp-weather-abc12345-service",
    );
  });

  test("truncates so the result fits the 63-char RFC 1123 label limit", () => {
    // Legacy `mcp-<slug>` names are not length-capped; the derived service
    // name is. The orphan sweep relies on this to reclaim a tombstone's
    // service, so a name that fits is the actual contract.
    const result = constructHttpServiceName(`mcp-${"a".repeat(80)}`);

    expect(result.length).toBeLessThanOrEqual(63);
    expect(result.endsWith("-service")).toBe(true);
  });

  test("replaces dots and trims non-alphanumeric edges", () => {
    expect(constructHttpServiceName("mcp.weather.v2")).toBe(
      "mcp-weather-v2-service",
    );
    expect(constructHttpServiceName("--mcp-weather--")).toBe(
      "mcp-weather-service",
    );
  });

  test("falls back to a valid name when the base sanitizes to empty", () => {
    expect(constructHttpServiceName("---")).toBe("mcp-server-service");
  });
});
