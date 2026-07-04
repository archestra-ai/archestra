import { describe, expect, it } from "vitest";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
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
    ...overrides,
  };
}

describe("isEditApiKeyFormValid", () => {
  it("accepts a personal-scoped key with no team", () => {
    expect(isEditApiKeyFormValid(makeValues({ scope: "personal" }))).toBe(true);
  });

  it("accepts an org-scoped key with no team", () => {
    expect(isEditApiKeyFormValid(makeValues({ scope: "org" }))).toBe(true);
  });

  it("rejects a team-scoped key with no team selected", () => {
    expect(
      isEditApiKeyFormValid(makeValues({ scope: "team", teamId: null })),
    ).toBe(false);
  });

  it("accepts a team-scoped key once a team is selected", () => {
    expect(
      isEditApiKeyFormValid(makeValues({ scope: "team", teamId: "team-1" })),
    ).toBe(true);
  });

  it("does not require an API key (the existing secret is kept on edit)", () => {
    expect(
      isEditApiKeyFormValid(makeValues({ scope: "personal", apiKey: null })),
    ).toBe(true);
  });

  it("requires AWS credentials when Bedrock SigV4 is selected", () => {
    expect(
      isEditApiKeyFormValid(
        makeValues({
          provider: "bedrock",
          bedrockAuthMethod: "sigv4",
          awsAccessKeyId: null,
          awsSecretAccessKey: null,
        }),
      ),
    ).toBe(false);
  });

  it("accepts Bedrock SigV4 once both AWS keys are provided", () => {
    expect(
      isEditApiKeyFormValid(
        makeValues({
          provider: "bedrock",
          bedrockAuthMethod: "sigv4",
          awsAccessKeyId: "AKIA...",
          awsSecretAccessKey: "secret",
        }),
      ),
    ).toBe(true);
  });

  it("does not require AWS credentials for Bedrock IAM or API-key auth", () => {
    expect(
      isEditApiKeyFormValid(
        makeValues({ provider: "bedrock", bedrockAuthMethod: "iam" }),
      ),
    ).toBe(true);
    expect(
      isEditApiKeyFormValid(
        makeValues({ provider: "bedrock", bedrockAuthMethod: "api-key" }),
      ),
    ).toBe(true);
  });

  it("still enforces team scope for Bedrock SigV4", () => {
    expect(
      isEditApiKeyFormValid(
        makeValues({
          provider: "bedrock",
          bedrockAuthMethod: "sigv4",
          awsAccessKeyId: "AKIA...",
          awsSecretAccessKey: "secret",
          scope: "team",
          teamId: null,
        }),
      ),
    ).toBe(false);
  });
});
