"use client";

import type { IdentityProviderDialogSection } from "./identity-provider-dialog-shell.ee";

export function getIdentityProviderDialogNavItems(
  providerType: "oidc" | "saml",
  options: { includeTokenDebugger?: boolean } = {},
): Array<{ id: IdentityProviderDialogSection; label: string }> {
  const tokenDebuggerNavItem = options.includeTokenDebugger
    ? ([{ id: "token-debugger", label: "Token Debugger" }] satisfies Array<{
        id: IdentityProviderDialogSection;
        label: string;
      }>)
    : [];

  if (providerType === "saml") {
    return [
      { id: "general", label: "SAML Settings" },
      { id: "service-provider-metadata", label: "SP Metadata" },
      { id: "attribute-mapping", label: "Attribute Mapping" },
      { id: "role-mapping", label: "Role Mapping" },
      { id: "team-sync", label: "Team Sync" },
      ...tokenDebuggerNavItem,
    ];
  }

  return [
    { id: "general", label: "OIDC Settings" },
    { id: "attribute-mapping", label: "Attribute Mapping" },
    {
      id: "enterprise-managed-credentials",
      label: "Enterprise Credentials",
    },
    { id: "role-mapping", label: "Role Mapping" },
    { id: "team-sync", label: "Team Sync" },
    ...tokenDebuggerNavItem,
  ];
}
