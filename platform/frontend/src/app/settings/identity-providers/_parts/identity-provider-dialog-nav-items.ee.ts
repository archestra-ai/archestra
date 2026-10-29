"use client";

import type { IdentityProviderDialogSection } from "./identity-provider-dialog-shell.ee";

export function getIdentityProviderDialogNavItems(
  providerType: "oidc" | "saml",
): Array<{
  id: IdentityProviderDialogSection;
  label: string;
  status?: string;
}> {
  if (providerType === "saml") {
    return [
      { id: "general", label: "SAML Settings" },
      { id: "attribute-mapping", label: "Attribute Mapping" },
      { id: "role-mapping", label: "Role Mapping" },
      { id: "team-sync", label: "Team Sync" },
    ];
  }

  return [
    { id: "general", label: "OIDC Settings" },
    { id: "attribute-mapping", label: "Attribute Mapping" },
    { id: "role-mapping", label: "Role Mapping" },
    { id: "team-sync", label: "Team Sync" },
    {
      id: "enterprise-managed-credentials",
      label: "Tool Authentication",
      status: "ID-JAG & token exchange",
    },
  ];
}
