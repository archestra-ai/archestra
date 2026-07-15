import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";

/**
 * Whether the edit-key form can be submitted. Editing keeps the existing secret
 * (the API key shows as a masked placeholder and AWS keys aren't prefilled), so
 * a name-only edit needs no secret. Beyond team-scope consistency, the one thing
 * the edit dialog can still require is Bedrock SigV4 credentials: the auth-method
 * tabs always open on "API Key", so SigV4 is only ever reached by a deliberate
 * user switch — one that must supply the AWS keys it is switching to.
 */
export function isEditApiKeyFormValid(
  values: LlmProviderApiKeyFormValues,
): boolean {
  const scopeOk = values.scope !== "team" || Boolean(values.teamId);
  if (values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4") {
    return (
      scopeOk && Boolean(values.awsAccessKeyId && values.awsSecretAccessKey)
    );
  }
  return scopeOk;
}
