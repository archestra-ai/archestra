import { IDENTITY_PROVIDER_ID } from "@shared";

type ClaimHint = {
  providerName: string;
  roleMappingNote: string;
  teamSyncNote: string;
};

export function getIdentityProviderClaimHint(
  providerId: string | undefined,
): ClaimHint | null {
  switch (providerId) {
    case IDENTITY_PROVIDER_ID.OKTA:
      return {
        providerName: "Okta",
        roleMappingNote:
          'Okta group-based role rules commonly read the `groups` claim, for example `{{#includes groups "group-name"}}true{{/includes}}`.',
        teamSyncNote:
          "Okta team sync commonly reads group names from the `groups` claim. Leave the template empty when Okta sends a flat `groups` array.",
      };
    case IDENTITY_PROVIDER_ID.ENTRA_ID:
      return {
        providerName: "Microsoft Entra ID",
        roleMappingNote:
          "Microsoft Entra ID role rules commonly read `roles` for App role assignments, or `groups` for group membership. Prefer `roles` when you assign Entra App roles.",
        teamSyncNote:
          "Microsoft Entra ID team sync commonly reads group identifiers from `groups`. Use `roles` only if you intentionally sync teams from Entra App roles.",
      };
    default:
      return null;
  }
}
