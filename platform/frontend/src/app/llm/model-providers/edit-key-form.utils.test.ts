import { describe, expect, it } from "vitest";
import type {
  LlmProviderApiKeyFormValues,
  ProviderBaseUrls,
} from "@/components/llm-provider-api-key-form";
import { isEditApiKeyFormValid } from "./edit-key-form.utils";

function makeValues(
  overrides: Partial<LlmProviderApiKeyFormValues>,
): LlmProviderApiKeyFormValues {
  return {
    name: "My key",
    provider: "openai",
    apiKey: null,
    baseUrl: null,
    inferenceBaseUrl: null,
    extraHeaders: [],
    scope: "personal",
    teamId: null,
    vaultSecretPath: null,
    vaultSecretKey: null,
    isPrimary: false,
    bedrockAuthMethod: "api-key",
    awsAccessKeyId: null,
    awsSecretAccessKey: null,
    awsSessionToken: null,
    openaiAuthMethod: "api-key",
    ...overrides,
  };
}

function check(
  overrides: Partial<LlmProviderApiKeyFormValues>,
  providerBaseUrls: ProviderBaseUrls = null,
): boolean {
  return isEditApiKeyFormValid({
    values: makeValues(overrides),
    providerBaseUrls,
  });
}

describe("isEditApiKeyFormValid", () => {
  it("accepts a personal-scoped key with no team", () => {
    expect(check({ scope: "personal" })).toBe(true);
  });

  it("accepts an org-scoped key with no team", () => {
    expect(check({ scope: "org" })).toBe(true);
  });

  it("rejects a team-scoped key with no team selected", () => {
    expect(check({ scope: "team", teamId: null })).toBe(false);
  });

  it("accepts a team-scoped key once a team is selected", () => {
    expect(check({ scope: "team", teamId: "team-1" })).toBe(true);
  });

  it("does not require an API key (the existing secret is kept on edit)", () => {
    expect(check({ scope: "personal", apiKey: null })).toBe(true);
  });

  it("requires AWS credentials when Bedrock SigV4 is selected", () => {
    expect(
      check({
        provider: "bedrock",
        bedrockAuthMethod: "sigv4",
        baseUrl: "https://bedrock.example.com",
        awsAccessKeyId: null,
        awsSecretAccessKey: null,
      }),
    ).toBe(false);
  });

  it("accepts Bedrock SigV4 once both AWS keys are provided", () => {
    expect(
      check({
        provider: "bedrock",
        bedrockAuthMethod: "sigv4",
        baseUrl: "https://bedrock.example.com",
        awsAccessKeyId: "AKIA...",
        awsSecretAccessKey: "secret",
      }),
    ).toBe(true);
  });

  it("does not require AWS credentials for Bedrock IAM or API-key auth", () => {
    expect(
      check({
        provider: "bedrock",
        bedrockAuthMethod: "iam",
        baseUrl: "https://bedrock.example.com",
      }),
    ).toBe(true);
    expect(
      check({
        provider: "bedrock",
        bedrockAuthMethod: "api-key",
        baseUrl: "https://bedrock.example.com",
      }),
    ).toBe(true);
  });

  it("still enforces team scope for Bedrock SigV4", () => {
    expect(
      check({
        provider: "bedrock",
        bedrockAuthMethod: "sigv4",
        baseUrl: "https://bedrock.example.com",
        awsAccessKeyId: "AKIA...",
        awsSecretAccessKey: "secret",
        scope: "team",
        teamId: null,
      }),
    ).toBe(false);
  });

  it("rejects a provider that requires a Base URL when none is set and no admin override exists", () => {
    expect(check({ provider: "archestra", baseUrl: null })).toBe(false);
  });

  it("accepts a Base-URL-required provider once the field is filled", () => {
    expect(
      check({ provider: "archestra", baseUrl: "https://my-archestra/v1" }),
    ).toBe(true);
  });

  it("accepts a Base-URL-required provider with no field value when an admin-configured override exists", () => {
    expect(
      check(
        { provider: "archestra", baseUrl: null },
        { archestra: "https://configured.example.com" },
      ),
    ).toBe(true);
  });

  it("does not require a Base URL for providers that don't opt in", () => {
    expect(check({ provider: "openai", baseUrl: null })).toBe(true);
  });
});
