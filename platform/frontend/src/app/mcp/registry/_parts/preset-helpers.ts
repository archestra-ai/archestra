import type { archestraApiTypes } from "@shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useTeams } from "@/lib/teams/team.query";

export type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

type PresetLike = {
  presetFieldValues?: Record<string, unknown> | null;
  presetSecretId?: string | null;
};

export type FieldScope = "static" | "preset" | "user";

export function fieldScope(field: {
  promptOnInstallation?: boolean;
  promptOnPreset?: boolean;
}): FieldScope {
  if (field.promptOnInstallation) return "user";
  if (field.promptOnPreset) return "preset";
  return "static";
}

export type FieldValueType = "string" | "number" | "boolean";

export type CatalogFieldEntry = {
  key: string;
  origin: "userConfig" | "envVar";
  scope: FieldScope;
  required: boolean;
  title?: string;
  description?: string;
  /** Only set for userConfig fields. When present on every userConfig field, the install form labels the section "Additional Headers" instead of "Connection Settings". */
  headerName?: string;
  /** True for env vars with type=secret or userConfig fields with sensitive=true. */
  secret: boolean;
  valueType: FieldValueType;
};

export function listCatalogFields(cat: CatalogItem): CatalogFieldEntry[] {
  const entries: CatalogFieldEntry[] = [];
  for (const [key, field] of Object.entries(cat.userConfig ?? {})) {
    entries.push({
      key,
      origin: "userConfig",
      scope: fieldScope(field),
      required: field.required ?? false,
      title: field.title,
      description: field.description,
      headerName: field.headerName,
      secret: !!field.sensitive,
      valueType:
        field.type === "boolean"
          ? "boolean"
          : field.type === "number"
            ? "number"
            : "string",
    });
  }
  for (const env of cat.localConfig?.environment ?? []) {
    entries.push({
      key: env.key,
      origin: "envVar",
      scope: fieldScope(env),
      required: env.required ?? false,
      description: env.description,
      secret: env.type === "secret",
      valueType:
        env.type === "boolean"
          ? "boolean"
          : env.type === "number"
            ? "number"
            : "string",
    });
  }
  return entries;
}

export function presetFieldKeys(cat: CatalogItem): string[] {
  return listCatalogFields(cat)
    .filter((f) => f.scope === "preset")
    .map((f) => f.key);
}

/** True when the given preset row is missing values for any preset-scoped field on its parent catalog. */
export function presetHasUnfilledFields(
  catalog: CatalogItem,
  preset: PresetLike | null | undefined,
): boolean {
  if (!preset) return false;
  const presetFields = listCatalogFields(catalog).filter(
    (f) => f.scope === "preset",
  );
  if (presetFields.length === 0) return false;
  const filled = preset.presetFieldValues ?? {};
  const hasStoredSecrets = preset.presetSecretId != null;
  return presetFields.some(
    (f) => !(f.key in filled) && !(f.secret && hasStoredSecrets),
  );
}

/**
 * Compile a preset-entry's `validationRegex` source into a `RegExp`.
 * Returns `null` when the source is empty/null or fails to compile (caller
 * treats both as "no validation").
 */
export function compileValidationRegex(
  source: string | null | undefined,
): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * Returns the validation error message for a single field value against the
 * preset's regex, or `null` if it passes. Only string-valued fields are
 * checked (numbers and booleans bypass — the regex is meant for free-text
 * values like URLs, hostnames, env names).
 *
 * `presetTerm` is the org-configured singular term — e.g. "Environment",
 * "Tenant" — surfaced verbatim in the error message so the wording matches the
 * admin's vocabulary instead of the hard-coded "preset".
 */
export function validateFieldAgainstRegex(params: {
  value: string;
  regex: RegExp | null;
  required: boolean;
  valueType: FieldValueType;
  presetTerm: string;
}): string | null {
  const { value, regex, required, valueType, presetTerm } = params;
  if (!regex) return null;
  if (valueType !== "string") return null;
  if (!value) return required ? "Required" : null;
  return regex.test(value)
    ? null
    : `Value does not match the ${presetTerm} Validation Rule`;
}

/**
 * Frontend mirror of `assertCanEditCatalogPresets` (backend):
 * an mcpServerInstallation admin, OR the author of a personal-scope catalog.
 */
export function useCanEditCatalogPresets(
  catalog: CatalogItem | null | undefined,
): { canEdit: boolean; isLoading: boolean } {
  const { data: isAdmin, isLoading: isAdminLoading } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: session, isPending: isSessionLoading } = useSession();
  const isLoading = isAdminLoading || isSessionLoading;

  if (!catalog) return { canEdit: false, isLoading };
  if (isAdmin) return { canEdit: true, isLoading };

  const currentUserId = session?.user?.id;
  const canEdit =
    !!currentUserId &&
    catalog.scope === "personal" &&
    catalog.authorId === currentUserId;
  return { canEdit, isLoading };
}

/**
 * Frontend mirror of the backend `requireMcpCatalogModifyPermission` rule that
 * gates editing a catalog item's metadata/config/visibility: an
 * mcpServerInstallation admin, a mcpRegistry:team-admin who is a member of one
 * of the item's teams (for team-scoped items), or the author of a personal
 * item. Broader than {@link useCanEditCatalogPresets}, which stays admin/author
 * only because preset editing has its own stricter backend gate.
 */
export function useCanModifyCatalogItem(
  catalog: CatalogItem | null | undefined,
): { canModify: boolean; isLoading: boolean } {
  const { data: isAdmin, isLoading: isAdminLoading } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: isTeamAdmin, isLoading: isTeamAdminLoading } =
    useHasPermissions({ mcpRegistry: ["team-admin"] });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: userTeams, isLoading: teamsLoading } = useTeams({
    enabled: !!canReadTeams,
  });
  const { data: session, isPending: isSessionLoading } = useSession();
  const isLoading =
    isAdminLoading ||
    isTeamAdminLoading ||
    isSessionLoading ||
    (!!canReadTeams && teamsLoading);

  if (!catalog) return { canModify: false, isLoading };
  if (isAdmin) return { canModify: true, isLoading };

  const currentUserId = session?.user?.id;
  if (catalog.scope === "personal") {
    return {
      canModify: !!currentUserId && catalog.authorId === currentUserId,
      isLoading,
    };
  }
  if (catalog.scope === "team" && isTeamAdmin) {
    const userTeamIdSet = new Set((userTeams ?? []).map((t) => t.id));
    return {
      canModify: !!catalog.teams?.some((t) => userTeamIdSet.has(t.id)),
      isLoading,
    };
  }
  return { canModify: false, isLoading };
}
