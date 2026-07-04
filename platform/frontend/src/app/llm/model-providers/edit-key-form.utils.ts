import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";

/**
 * Whether the edit-key form can be submitted. Editing never re-collects the
 * existing secret (the API key shows as a masked placeholder and AWS keys
 * aren't prefilled), so requiring a secret would wrongly block a name-only
 * edit. The only thing the edit dialog can meaningfully re-validate is
 * team-scope consistency: a team-scoped key must name a team.
 */
export function isEditApiKeyFormValid(
  values: LlmProviderApiKeyFormValues,
): boolean {
  return values.scope !== "team" || Boolean(values.teamId);
}
