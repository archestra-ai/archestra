import { beforeEach, describe, expect, test } from "vitest";
import config from "@/config";
import { azureCapabilityConfigurationHash } from "./azure-capability-scope";

const configuration = {
  baseUrl: "https://resource.openai.azure.com/openai",
  inferenceBaseUrl: null,
  secretId: "synthetic-secret-reference",
  extraHeaders: {
    Authorization: "Bearer synthetic-secret",
    "x-route": "deployment-a",
  },
};

beforeEach(() => {
  config.auth.secret = "synthetic-deployment-secret-a";
});

describe("Azure capability configuration identity", () => {
  test("is stable across calls and header insertion order without exposing values", () => {
    const digest = azureCapabilityConfigurationHash(configuration);
    expect(digest).toMatch(/^hmac-sha256-v1:[a-f0-9]{64}$/);
    expect(
      azureCapabilityConfigurationHash({
        ...configuration,
        extraHeaders: {
          "x-route": "deployment-a",
          Authorization: "Bearer synthetic-secret",
        },
      }),
    ).toBe(digest);
    expect(digest).not.toContain("synthetic-secret");
    expect(digest).not.toContain("deployment-a");
  });

  test.each([
    { baseUrl: "https://other.openai.azure.com/openai" },
    { inferenceBaseUrl: "https://gateway.example.test" },
    { secretId: "another-secret-reference" },
    {
      extraHeaders: {
        ...configuration.extraHeaders,
        Authorization: "Bearer rotated-secret",
      },
    },
    {
      extraHeaders: {
        ...configuration.extraHeaders,
        "x-route": "deployment-b",
      },
    },
    { extraHeaders: { "x-route": "deployment-a" } },
  ])("changes when routing or credentials change: %j", (change) => {
    expect(
      azureCapabilityConfigurationHash({ ...configuration, ...change }),
    ).not.toBe(azureCapabilityConfigurationHash(configuration));
  });

  test("normalizes absent optional values and preserves unambiguous field boundaries", () => {
    expect(
      azureCapabilityConfigurationHash({
        baseUrl: null,
        inferenceBaseUrl: null,
        secretId: null,
        extraHeaders: null,
      }),
    ).toBe(
      azureCapabilityConfigurationHash({
        baseUrl: undefined,
        inferenceBaseUrl: undefined,
        secretId: undefined,
        extraHeaders: {},
      }),
    );
    expect(
      azureCapabilityConfigurationHash({
        ...configuration,
        extraHeaders: { ab: "c" },
      }),
    ).not.toBe(
      azureCapabilityConfigurationHash({
        ...configuration,
        extraHeaders: { a: "bc" },
      }),
    );
  });

  test("uses the shared deployment secret and rejects a missing key", () => {
    const original = azureCapabilityConfigurationHash(configuration);
    config.auth.secret = "synthetic-deployment-secret-b";
    expect(azureCapabilityConfigurationHash(configuration)).not.toBe(original);
    config.auth.secret = "synthetic-deployment-secret-a";
    expect(azureCapabilityConfigurationHash(configuration)).toBe(original);
    config.auth.secret = undefined;
    expect(() => azureCapabilityConfigurationHash(configuration)).toThrow(
      "auth secret is required",
    );
  });
});
