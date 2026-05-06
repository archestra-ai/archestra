import type { archestraApiTypes } from "@shared";

export type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/**
 * A "preset" in the UI is a child catalog item — a row in
 * internal_mcp_catalog with `parentCatalogItemId` set to the parent's id.
 * Same shape as the parent (full InternalMcpCatalog), so a parent row is
 * also assignable to this type when building [parent, ...children] lists.
 */
export type Preset =
  archestraApiTypes.GetCatalogChildrenResponses["200"][number];

export type UserConfigField = NonNullable<CatalogItem["userConfig"]>[string];

export type EnvField = NonNullable<
  NonNullable<CatalogItem["localConfig"]>["environment"]
>[number];

export type FieldScope = "static" | "preset" | "user";

export function fieldScope(field: {
  promptOnInstallation?: boolean;
  promptOnPreset?: boolean;
}): FieldScope {
  if (field.promptOnInstallation) return "user";
  if (field.promptOnPreset) return "preset";
  return "static";
}

/**
 * Iterate every per-field declaration on a catalog: userConfig entries plus
 * localConfig.environment entries, normalized to a common shape. Used by the
 * preset editor (to pick the inputs an admin should fill) and the field
 * audit list.
 */
export type CatalogFieldEntry = {
  key: string;
  origin: "userConfig" | "envVar";
  scope: FieldScope;
  required: boolean;
  description?: string;
  staticValue?: string | number | boolean | string[];
};

export function listCatalogFields(cat: CatalogItem): CatalogFieldEntry[] {
  const entries: CatalogFieldEntry[] = [];
  for (const [key, field] of Object.entries(cat.userConfig ?? {})) {
    entries.push({
      key,
      origin: "userConfig",
      scope: fieldScope(field),
      required: field.required ?? false,
      description: field.description,
      staticValue: field.default,
    });
  }
  for (const env of cat.localConfig?.environment ?? []) {
    entries.push({
      key: env.key,
      origin: "envVar",
      scope: fieldScope(env),
      required: env.required ?? false,
      description: env.description,
      staticValue: env.value ?? env.default,
    });
  }
  return entries;
}
