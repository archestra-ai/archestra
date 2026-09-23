import { describe, expect, it } from "vitest";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import {
  isEditApiKeyFormValid,
  subscriptionSignInRequired,
} from "./edit-key-form.utils";

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
    shared: false,
    teamId: null,
    vaultSecretPath: null,
    vaultSecretKey: null,
    isPrimary: false,
    bedrockAuthMethod: "api-key",
    awsAccessKeyId: null,
    awsSecretAccessKey: null,
    awsSessionToken: null,
    authMethod: "api-key",
    ...overrides,
  };
}

describe("isEditApiKeyFormValid", () => {
  it("accepts an own key and a shared key alike", () => {
    expect(isEditApiKeyFormValid(makeValues({ shared: false }))).toBe(true);
    expect(isEditApiKeyFormValid(makeValues({ shared: true }))).toBe(true);
  });

  it("does not require an API key (the existing secret is kept on edit)", () => {
    expect(isEditApiKeyFormValid(makeValues({ apiKey: null }))).toBe(true);
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
});

describe("subscriptionSignInRequired", () => {
  const placeholder = "••••••••••••••••";

  it("requires a sign-in when the subscription tab is selected on a key that is not that subscription", () => {
    // Submitting here would privatize the shared key (subscription keys are
    // personal-only) while silently keeping its old shared secret.
    const values = makeValues({
      shared: true,
      authMethod: "subscription",
      apiKey: null,
    });
    expect(subscriptionSignInRequired(values, { subscriptionKind: null })).toBe(
      true,
    );
    expect(isEditApiKeyFormValid(values, { subscriptionKind: null })).toBe(
      false,
    );
  });

  it("treats the masked placeholder as no sign-in", () => {
    expect(
      subscriptionSignInRequired(
        makeValues({ authMethod: "subscription", apiKey: placeholder }),
        { subscriptionKind: null },
      ),
    ).toBe(true);
  });

  it("passes once a sign-in produced a credential", () => {
    expect(
      subscriptionSignInRequired(
        makeValues({ authMethod: "subscription", apiKey: "chatgpt-oauth:abc" }),
        { subscriptionKind: null },
      ),
    ).toBe(false);
  });

  it("needs no fresh sign-in when the key already holds this subscription", () => {
    expect(
      subscriptionSignInRequired(
        makeValues({ authMethod: "subscription", apiKey: placeholder }),
        { subscriptionKind: "chatgpt" },
      ),
    ).toBe(false);
  });

  it("ignores a provider with no credential-level subscription", () => {
    expect(
      subscriptionSignInRequired(
        makeValues({ provider: "anthropic", authMethod: "subscription" }),
        { subscriptionKind: null },
      ),
    ).toBe(false);
  });

  it("ignores the api-key auth mode entirely", () => {
    expect(
      subscriptionSignInRequired(makeValues({ authMethod: "api-key" }), {
        subscriptionKind: null,
      }),
    ).toBe(false);
  });
});
