import {
  isBaseUrlRequiredForProvider,
  type LlmProviderApiKeyFormValues,
  type ProviderBaseUrls,
} from "@/components/llm-provider-api-key-form";

/**
 * Whether the edit-key form can be submitted. Editing keeps the existing secret
 * (the API key shows as a masked placeholder and AWS keys aren't prefilled), so
 * a name-only edit needs no secret. Beyond team-scope consistency, the edit
 * dialog can still require: Bedrock SigV4 credentials (the auth-method tabs
 * always open on "API Key", so SigV4 is only ever reached by a deliberate
 * user switch — one that must supply the AWS keys it is switching to), and a
 * Base URL for providers that require one — mirrors the field's own validator
 * via `isBaseUrlRequiredForProvider` so a value folded into the
 * onboarding-variant Advanced settings accordion can't silently block "Save"
 * while this reports the form as valid.
 */
export function isEditApiKeyFormValid({
  values,
  providerBaseUrls,
}: {
  values: LlmProviderApiKeyFormValues;
  providerBaseUrls: ProviderBaseUrls;
}): boolean {
  const scopeOk = values.scope !== "team" || Boolean(values.teamId);
  const baseUrlOk =
    !isBaseUrlRequiredForProvider({
      provider: values.provider,
      providerBaseUrls,
    }) || Boolean(values.baseUrl);

  if (values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4") {
    return (
      scopeOk &&
      baseUrlOk &&
      Boolean(values.awsAccessKeyId && values.awsSecretAccessKey)
    );
  }
  return scopeOk && baseUrlOk;
}
