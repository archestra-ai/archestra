import {
  isCredentialLevelSubscriptionProvider,
  subscriptionKindForProvider,
} from "@archestra/shared";
import {
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  type LlmProviderApiKeyFormValues,
} from "@/components/llm-provider-api-key-form";

/**
 * Whether the edit-key form can be submitted. Editing keeps the existing secret
 * (the API key shows as a masked placeholder and AWS keys aren't prefilled), so
 * a name-only edit needs no secret. Beyond team-scope consistency, the edit
 * dialog can still require a credential in two cases — both only reachable by a
 * deliberate auth-method switch, which must supply the credential it is
 * switching to: Bedrock SigV4 (the AWS key pair) and a subscription tab on a
 * key that does not hold that subscription (a completed sign-in).
 */
export function isEditApiKeyFormValid(
  values: LlmProviderApiKeyFormValues,
  existingKey?: { subscriptionKind?: string | null },
): boolean {
  const scopeOk = values.scope !== "team" || Boolean(values.teamId);
  if (values.provider === "bedrock" && values.bedrockAuthMethod === "sigv4") {
    return (
      scopeOk && Boolean(values.awsAccessKeyId && values.awsSecretAccessKey)
    );
  }
  if (subscriptionSignInRequired(values, existingKey)) {
    return false;
  }
  return scopeOk;
}

/**
 * True when the auth-method tabs sit on a subscription the stored key does not
 * hold and no sign-in has completed. Submitting in that state must be blocked:
 * subscription keys are personal-only, so the update would privatize a shared
 * key while silently keeping its old shared secret. A key that already holds
 * this subscription needs no fresh sign-in — keeping the stored credential is
 * exactly what editing means.
 */
export function subscriptionSignInRequired(
  values: LlmProviderApiKeyFormValues,
  existingKey?: { subscriptionKind?: string | null },
): boolean {
  if (
    values.authMethod !== "subscription" ||
    !isCredentialLevelSubscriptionProvider(values.provider)
  ) {
    return false;
  }
  if (
    existingKey?.subscriptionKind != null &&
    existingKey.subscriptionKind ===
      subscriptionKindForProvider(values.provider)
  ) {
    return false;
  }
  return !values.apiKey || values.apiKey === LLM_PROVIDER_API_KEY_PLACEHOLDER;
}
