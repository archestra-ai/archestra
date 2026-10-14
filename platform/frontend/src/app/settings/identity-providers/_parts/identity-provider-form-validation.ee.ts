// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { IdentityProviderFormValues } from "@archestra/shared";
import type { FieldErrors, FieldPath } from "react-hook-form";
import type { IdentityProviderDialogSection } from "./identity-provider-dialog-shell.ee";

export function getIdentityProviderFormIssue(
  errors: FieldErrors<IdentityProviderFormValues>,
) {
  const issue = firstIssue(errors);
  if (!issue) return null;
  const path = issue.path as FieldPath<IdentityProviderFormValues>;
  let section: IdentityProviderDialogSection = "general";
  if (path.startsWith("roleMapping")) section = "role-mapping";
  else if (path.startsWith("teamSyncConfig")) section = "team-sync";
  else if (
    path.startsWith("oidcConfig.mapping") ||
    path.startsWith("samlConfig.mapping")
  )
    section = "attribute-mapping";
  else if (path.startsWith("oidcConfig.enterpriseManagedCredentials"))
    section = "enterprise-managed-credentials";
  else if (path.startsWith("samlConfig.spMetadata"))
    section = "service-provider-metadata";
  return { ...issue, path, section };
}

function firstIssue(
  value: unknown,
  path = "",
): { path: string; message: string } | null {
  if (!value || typeof value !== "object") return null;
  if ("message" in value && typeof value.message === "string")
    return { path, message: value.message };
  for (const [key, child] of Object.entries(value)) {
    if (key === "ref" || key === "types") continue;
    const found = firstIssue(child, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}
